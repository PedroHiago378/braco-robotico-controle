// Controlador de movimento: gera segmentos de duração fixa (1/taxaHz) a partir de "fontes"
// (seguir alvo, trajetória planejada, timeline, frenagem) e os envia ao firmware,
// mantendo cerca de bufferMs de movimento na fila dele.

import { Emissor, clamp, difAngular } from './util.js';
import { grausParaPassos, passosParaGraus } from './config.js';
import { planejarJunta, planejarLinear } from './trajetoria.js';
import { formatarSegmento } from '../hardware/protocolo.js';

const FIM = Symbol('fim');
const OCIOSO = Symbol('ocioso');

/** Velocidade máxima que ainda permite parar em `dist` com aceleração `a` (tempo discreto). */
function velParada(dist, a, dt) {
  return Math.sqrt(a * a * dt * dt + 2 * a * dist) - a * dt;
}

// ---------------------------------------------------------------------------------------
// Fontes de movimento: iniciar(ctl) e proxima(dt, ctl) -> {q, tau?} | OCIOSO | FIM

class FonteSeguirJunta {
  tipo = 'seguir';
  constructor(alvo) {
    this.alvo = [...alvo];
  }
  iniciar(ctl) {
    this.v = [...ctl.vCmd];
  }
  proxima(dt, ctl) {
    const f = ctl.fatorVelocidade;
    let movendo = false;
    const q = ctl.qCmd.map((qi, i) => {
      const j = ctl.config.juntas[i];
      const vmax = j.velMax * f;
      const amax = j.accMax * f;
      const e = clamp(this.alvo[i], j.min, j.max) - qi;
      const ae = Math.abs(e);
      if (ae <= amax * dt * dt && Math.abs(this.v[i]) <= amax * dt) {
        this.v[i] = 0;
        if (ae > 1e-9) movendo = true;
        return qi + e;
      }
      const vDes = Math.sign(e) * Math.min(vmax, velParada(ae, amax, dt));
      this.v[i] += clamp(vDes - this.v[i], -amax * dt, amax * dt);
      movendo = true;
      return qi + this.v[i] * dt;
    });
    return movendo ? { q } : OCIOSO;
  }
}

class FonteSeguirCartesiana {
  tipo = 'seguir';
  constructor(alvo) {
    this.alvo = { ...alvo };
  }
  iniciar(ctl) {
    const p = ctl.cin.pose(ctl.qCmd);
    this.p = [p.x, p.y, p.z];
    this.phi = p.phi;
    this.v = [0, 0, 0];
    this.vphi = 0;
    this.ramos = ctl.cin.ramos(ctl.qCmd);
  }
  proxima(dt, ctl) {
    const c = ctl.config.controle;
    const f = ctl.fatorVelocidade;
    const vmax = c.velCartesiana * f;
    const amax = c.accCartesiana * f;
    const e = [this.alvo.x - this.p[0], this.alvo.y - this.p[1], this.alvo.z - this.p[2]];
    const d = Math.hypot(...e);
    const vDes = d > 1e-6 ? e.map((x) => (x / d) * Math.min(vmax, velParada(d, amax, dt))) : [0, 0, 0];
    const dv = vDes.map((x, k) => x - this.v[k]);
    const ndv = Math.hypot(...dv);
    const lim = amax * dt;
    const v = this.v.map((x, k) => x + (ndv > lim ? (dv[k] * lim) / ndv : dv[k]));
    const p = this.p.map((x, k) => x + v[k] * dt);

    const ephi = difAngular(this.phi, this.alvo.phi);
    const vpmax = c.velPhi * f;
    const apmax = c.accPhi * f;
    const vpDes = Math.sign(ephi) * Math.min(vpmax, velParada(Math.abs(ephi), apmax, dt));
    const vphi = this.vphi + clamp(vpDes - this.vphi, -apmax * dt, apmax * dt);
    const phi = this.phi + vphi * dt;

    const parado = d < 1e-4 && Math.hypot(...v) < 1e-6 && Math.abs(ephi) < 1e-4 && Math.abs(vphi) < 1e-6;
    if (parado) {
      this.v = [0, 0, 0];
      this.vphi = 0;
      return OCIOSO;
    }
    const sol = ctl.cin.melhorSolucao({ x: p[0], y: p[1], z: p[2], phi }, ctl.qCmd, ctl.config.juntas, this.ramos);
    if (!sol) {
      this.v = [0, 0, 0];
      this.vphi = 0;
      this.alvo = { x: this.p[0], y: this.p[1], z: this.p[2], phi: this.phi };
      ctl._aviso('alcance', 'Seguimento cartesiano parou: caminho sai do alcance');
      return OCIOSO;
    }
    this.p = p;
    this.v = v;
    this.phi = phi;
    this.vphi = vphi;
    return { q: sol.q };
  }
}

class FontePlano {
  tipo = 'trajetoria';
  constructor(planejar) {
    this.planejar = planejar;
  }
  iniciar(ctl) {
    this.tau = 0;
    this.feito = false;
    this.plano = this.planejar(ctl.qCmd, ctl);
    if (this.plano.erro) this.erro = this.plano.erro;
  }
  proxima(dt) {
    if (this.erro || this.feito || !(this.plano.T > 0)) return FIM;
    this.tau += dt;
    if (this.tau >= this.plano.T) {
      this.feito = true;
      return { q: this.plano.amostrar(this.plano.T) };
    }
    return { q: this.plano.amostrar(this.tau) };
  }
}

class FonteTimeline {
  tipo = 'timeline';
  constructor(timeline, ctx, opts) {
    this.timeline = timeline;
    this.ctx = ctx;
    this.opts = opts;
  }
  iniciar(ctl) {
    const t0 = this.timeline.keyframes[0]?.t ?? 0;
    this.T = this.timeline.duracao;
    this.tau = Math.max(this.opts.inicio ?? 0, t0);
    // começando no meio, a velocidade do caminho não é zero: acelera com rampa de taxa
    this.taxaAlvo = ctl.fatorVelocidade;
    this.taxa = this.tau > t0 + 1e-9 ? 0 : (this.opts.taxaInicial ?? this.taxaAlvo);
    this.rampa = this.taxa === 0 ? this._rampa(ctl, this.taxaAlvo) : 0.3;
    this.parando = false;
    this.terminou = false;
  }
  /** Duração da rampa de taxa para que nenhuma junta passe de accMax (com folga). */
  _rampa(ctl, deltaTaxa) {
    const h = 0.01;
    const a = this.timeline.amostrar(Math.max(0, this.tau - h), this.ctx);
    const b = this.timeline.amostrar(Math.min(this.T, this.tau + h), this.ctx);
    let r = 0.15;
    ctl.config.juntas.forEach((j, i) => {
      const vPath = Math.abs(b[i] - a[i]) / (2 * h);
      r = Math.max(r, (vPath * Math.abs(deltaTaxa) * 1.3) / j.accMax);
    });
    return r;
  }
  definirTaxa(ctl, taxa) {
    if (this.parando) return;
    this.rampa = this._rampa(ctl, taxa - this.taxa);
    this.taxaAlvo = taxa;
  }
  pausar(ctl) {
    this.definirTaxa(ctl, 0);
  }
  continuar(ctl) {
    this.definirTaxa(ctl, ctl.fatorVelocidade);
  }
  parar(ctl) {
    this.definirTaxa(ctl, 0);
    this.parando = true;
  }
  get pausado() {
    return this.taxaAlvo === 0 && !this.parando;
  }
  proxima(dt) {
    if (this.terminou) return FIM;
    if (this.taxa !== this.taxaAlvo) {
      const passo = dt / this.rampa;
      this.taxa = this.taxa < this.taxaAlvo ? Math.min(this.taxaAlvo, this.taxa + passo) : Math.max(this.taxaAlvo, this.taxa - passo);
    }
    if (this.taxa <= 0) return this.parando ? FIM : OCIOSO;
    this.tau += this.taxa * dt;
    if (this.tau >= this.T) {
      this.tau = this.T;
      this.terminou = true;
    }
    return { q: this.timeline.amostrar(this.tau, this.ctx), tau: this.tau };
  }
}

class FonteFreio {
  tipo = 'freio';
  iniciar(ctl) {
    this.v = [...ctl.vCmd];
  }
  proxima(dt, ctl) {
    if (this.v.every((v) => v === 0)) return FIM;
    const q = ctl.qCmd.map((qi, i) => {
      const a = ctl.config.juntas[i].accMax;
      const v = this.v[i];
      const nv = Math.sign(v) * Math.max(0, Math.abs(v) - a * dt);
      this.v[i] = nv;
      return qi + ((v + nv) / 2) * dt;
    });
    return { q };
  }
}

// ---------------------------------------------------------------------------------------

export class Controlador extends Emissor {
  constructor({ config, cin, link, agora }) {
    super();
    this.config = config;
    this.cin = cin;
    this.link = link;
    this.agora = agora ?? (() => performance.now());
    this.qCmd = [...config.poseInicial];
    this.vCmd = [0, 0, 0, 0];
    this.qReal = null;
    this.fonte = null;
    this.fontes = [];
    this.execFim = 0;
    this.historico = [];
    this.fatorVelocidade = 1;
    this.bloqueado = false;
    this._modo = 'parado';
    this._ultimoPedidoStatus = -1e9;
    this._avisos = new Map();
    this._ressincronizar = false;
    link.on('status', (s) => this._aoStatus(s));
    link.on('estado', (e) => {
      if (e !== 'pronto') this.cancelar('Conexão perdida');
    });
  }

  get modo() {
    return this.fonte?.tipo ?? this.fontes[0]?.tipo ?? 'parado';
  }

  /** Executando trajetória, timeline ou frenagem (não aceita seguir alvo). */
  get ocupado() {
    return ['trajetoria', 'timeline', 'freio'].includes(this.modo);
  }

  get timelineAtiva() {
    const f = this.fonte?.tipo === 'timeline' ? this.fonte : this.fontes.find((x) => x.tipo === 'timeline');
    return f ?? null;
  }

  definirConfig(config) {
    this.config = config;
  }

  sincronizar(q) {
    this.qCmd = [...q];
    this.vCmd = [0, 0, 0, 0];
  }

  definirFatorVelocidade(f) {
    this.fatorVelocidade = clamp(f, 0.05, 1);
    const tl = this.fonte?.tipo === 'timeline' ? this.fonte : null;
    if (tl && !tl.pausado && !tl.parando) tl.definirTaxa(this, this.fatorVelocidade);
  }

  /** Chamado pelo relógio (~5 ms). */
  passo() {
    const agora = this.agora();
    this._pedirStatusSePreciso(agora);
    if (this.link.pronto && !this.bloqueado) this._gerar(agora);
    const m = this.modo;
    if (m !== this._modo) {
      this._modo = m;
      this.emit('modo', m);
    }
  }

  _gerar(agora) {
    const c = this.config.controle;
    const dtMs = 1000 / c.taxaHz;
    if (this.execFim < agora) this.execFim = agora;
    for (let n = 0; n < 60 && this.execFim - agora < c.bufferMs; n++) {
      if (!this.fonte) {
        this.fonte = this.fontes.shift() ?? null;
        if (!this.fonte) break;
        this.fonte.iniciar?.(this);
      }
      const r = this.fonte.proxima(dtMs / 1000, this);
      if (r === OCIOSO) {
        this.vCmd = [0, 0, 0, 0];
        break;
      }
      if (r === FIM) {
        this._concluir(this.fonte);
        continue;
      }
      this._enviar(r.q, dtMs, r.tau);
    }
  }

  _enviar(q, dtMs, tau) {
    const dt = dtMs / 1000;
    const folga = this.config.controle.folgaVelocidade;
    let cortou = false;
    const qS = q.map((v, i) => {
      const j = this.config.juntas[i];
      let w = clamp(v, j.min, j.max);
      const maxd = j.velMax * folga * dt;
      const d = w - this.qCmd[i];
      if (Math.abs(d) > maxd) {
        w = this.qCmd[i] + Math.sign(d) * maxd;
        cortou = true;
      }
      return w;
    });
    if (cortou) this._aviso('trava', 'Trava de segurança limitou a velocidade de uma junta');
    const passos = grausParaPassos(this.config, qS);
    this.link.comando(formatarSegmento(dtMs * 1000, passos), { segMs: dtMs }).catch((e) => this._falhaSegmento(e));
    this.vCmd = qS.map((v, i) => (v - this.qCmd[i]) / dt);
    this.qCmd = qS;
    this.execFim += dtMs;
    this.historico.push({ fim: this.execFim, tau, q: qS });
    if (this.historico.length > 500) this.historico.splice(0, this.historico.length - 500);
  }

  _concluir(f) {
    this.fonte = null;
    if (f.erro) {
      this._encerrarSessao(f, new Error(f.erro));
      this.cancelar(f.erro);
      this._aviso('plano', f.erro, 0);
      return;
    }
    if (f.tipo === 'timeline' && f.opts.loop && !f.parando) {
      const tl = f.timeline;
      const proxima = new FonteTimeline(tl, f.ctx, { ...f.opts, inicio: 0, taxaInicial: f.taxa });
      proxima.sessao = f.sessao;
      proxima.final = true;
      const fontes = [proxima];
      if (!tl.loopContinuo()) {
        const q0 = tl.keyframes[0].q;
        fontes.unshift(new FontePlano((qi) => planejarJunta(qi, q0, this.config.juntas, this.fatorVelocidade)));
      }
      this.fontes.unshift(...fontes);
      this.emit('loop');
      return;
    }
    if (f.final) this._encerrarSessao(f, null, !f.parando);
  }

  _encerrarSessao(f, erro, completo = true) {
    const s = f.sessao;
    if (!s || s.feita) return;
    s.feita = true;
    if (erro) s.reject(erro);
    else s.resolve(completo);
  }

  _falhaSegmento(e) {
    if (this.fonte || this.fontes.length) this.cancelar(e.message);
    this._ressincronizar = true;
    this._aviso('segmento', e.message);
  }

  _aviso(chave, msg, intervaloMs = 1500) {
    const agora = this.agora();
    if (agora - (this._avisos.get(chave) ?? -1e9) < intervaloMs) return;
    this._avisos.set(chave, agora);
    this.emit('aviso', msg);
  }

  /** Descarta todas as fontes (o que já está na fila do firmware ainda executa). */
  cancelar(motivo = 'Cancelado') {
    const todas = [this.fonte, ...this.fontes].filter(Boolean);
    this.fonte = null;
    this.fontes = [];
    for (const f of todas) this._encerrarSessao(f, new Error(motivo));
  }

  _sessao(fontes) {
    this.cancelar('Substituído por outro movimento');
    return new Promise((resolve, reject) => {
      const s = { resolve, reject, feita: false };
      fontes.forEach((f) => (f.sessao = s));
      fontes[fontes.length - 1].final = true;
      if (this.vCmd.some((v) => Math.abs(v) > 0.5)) fontes.unshift(new FonteFreio());
      this.fontes = fontes;
    });
  }

  // ---- API de movimento -------------------------------------------------------------

  /** Segue um alvo em ângulos (atualizável a qualquer momento). Retorna false se ocupado. */
  seguir(qAlvo) {
    if (this.fonte instanceof FonteSeguirJunta && !this.fontes.length) {
      this.fonte.alvo = [...qAlvo];
      return true;
    }
    if (this.ocupado) return false;
    this.cancelar('Substituído');
    this.fontes = [new FonteSeguirJunta(qAlvo)];
    return true;
  }

  /** Segue um alvo cartesiano {x,y,z,phi} com a ponta em linha reta. */
  seguirPose(pose) {
    if (this.fonte instanceof FonteSeguirCartesiana && !this.fontes.length) {
      this.fonte.alvo = { ...pose };
      return true;
    }
    if (this.ocupado) return false;
    this.cancelar('Substituído');
    this.fontes = [new FonteSeguirCartesiana(pose)];
    return true;
  }

  moverJunta(qAlvo) {
    return this._sessao([
      new FontePlano((q0) => planejarJunta(q0, qAlvo, this.config.juntas, this.fatorVelocidade)),
    ]);
  }

  moverLinear(pose) {
    return this._sessao([
      new FontePlano((q0) =>
        planejarLinear(this.cin, this.config.juntas, this.config.controle, q0, pose, {
          fator: this.fatorVelocidade,
          taxaHz: this.config.controle.taxaHz,
        }),
      ),
    ]);
  }

  /**
   * Leva o braço à pose da timeline em `inicio` (movimento de junta) e executa.
   * Resolve true ao terminar, false se parado; rejeita em erro/emergência.
   */
  executarTimeline(timeline, ctx, { loop = false, inicio = 0 } = {}) {
    if (timeline.keyframes.length < 2) return Promise.reject(new Error('A timeline precisa de ao menos 2 keyframes'));
    const t0 = Math.max(inicio, timeline.keyframes[0].t);
    const qInicio = timeline.amostrar(t0, ctx);
    return this._sessao([
      new FontePlano((q0) => planejarJunta(q0, qInicio, this.config.juntas, this.fatorVelocidade)),
      new FonteTimeline(timeline, ctx, { loop, inicio: t0 }),
    ]);
  }

  pausar() {
    const f = this.fonte;
    if (f?.tipo === 'timeline') f.pausar(this);
  }

  continuar() {
    const f = this.fonte;
    if (f?.tipo === 'timeline') f.continuar(this);
  }

  get pausado() {
    return this.fonte?.tipo === 'timeline' && this.fonte.pausado;
  }

  /** Para com desaceleração (timeline desacelera ao longo do caminho). */
  pararSuave() {
    for (const f of this.fontes) this._encerrarSessao(f, null, false);
    this.fontes = [];
    const f = this.fonte;
    if (f?.tipo === 'timeline') {
      f.parar(this);
      return;
    }
    if (f && f.tipo !== 'freio') {
      this._encerrarSessao(f, null, false);
      this.fonte = null;
      this.fontes = [new FonteFreio()];
    }
  }

  /** Para com desaceleração e resolve quando não houver mais movimento sendo gerado. */
  pararEsperar() {
    this.pararSuave();
    return new Promise((resolve) => {
      const verificar = () => (this.modo === 'parado' || !this.link.pronto ? resolve() : setTimeout(verificar, 20));
      verificar();
    });
  }

  emergencia() {
    this.link.emergencia();
    this.cancelar('Parada de emergência');
    this.vCmd = [0, 0, 0, 0];
    this.execFim = this.agora();
    this._ressincronizar = true;
    this.emit('emergencia');
  }

  // ---- realimentação ----------------------------------------------------------------

  _pedirStatusSePreciso(agora) {
    if (!this.link.pronto) return;
    const ativo = this.fonte || this.fontes.length || this.execFim > agora;
    if (agora - this._ultimoPedidoStatus >= (ativo ? 40 : 150)) {
      this._ultimoPedidoStatus = agora;
      this.link.pedirStatus();
    }
  }

  _aoStatus(s) {
    this.qReal = passosParaGraus(this.config, s.passos);
    const agora = this.agora();
    const emVoo = this.link.msEmVoo;
    if (s.bufferMs > 0 || emVoo > 0) this.execFim = agora + s.bufferMs + emVoo;
    if (s.estado === 'ALARME') {
      if (this.fonte || this.fontes.length) this.cancelar('Firmware em alarme');
      this._ressincronizar = true;
    }
    if (this._ressincronizar && s.fila === 0 && this.link.emVoo.length === 0) {
      this.sincronizar(this.qReal);
      this._ressincronizar = false;
    }
    this.emit('real', this.qReal, s);
  }

  /** Instante da timeline sendo executado agora (descontando a fila do firmware). */
  tauExecutando() {
    const agora = this.agora();
    const h = this.historico;
    for (let i = 0; i < h.length; i++) {
      if (h[i].fim >= agora && h[i].tau !== undefined) {
        const ant = h[i - 1];
        if (!ant || ant.tau === undefined) return h[i].tau;
        const dur = h[i].fim - ant.fim;
        const u = dur > 0 ? clamp(1 - (h[i].fim - agora) / dur, 0, 1) : 1;
        return ant.tau + (h[i].tau - ant.tau) * u;
      }
    }
    for (let i = h.length - 1; i >= 0; i--) if (h[i].tau !== undefined) return h[i].tau;
    return null;
  }
}
