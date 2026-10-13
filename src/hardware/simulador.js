// Firmware virtual: implementa o mesmo protocolo do firmware real, com execução em tempo real.
// Permite usar o app inteiro sem o braço. O transporte simulado tem a mesma interface do serial.

import { formatarStatus } from './protocolo.js';

const ADIAR = Symbol('adiar');

export class FirmwareVirtual {
  constructor({ agora, enviar, tickHz = 40000, filaMax = 64, rx = 1024 }) {
    this.agora = agora;
    this.enviar = enviar;
    this.tickHz = tickHz;
    this.filaMax = filaMax;
    this.rx = rx;
    this.reiniciar();
  }

  reiniciar() {
    this.posInt = [0, 0, 0, 0]; // posição no fim do último segmento concluído
    this.pos = [0, 0, 0, 0];
    this.ultimoAlvo = [0, 0, 0, 0];
    this.fila = [];
    this.atual = null;
    this.fimUltimo = 0;
    this.pendentes = [];
    this.alarme = 0;
    this.motores = false;
    this.ref = false;
    this.vmax = [4000, 4000, 4000, 4000];
    this.homing = null;
    this.fins = [false, false, false, false];
  }

  hello() {
    return `BRACO 1.0-sim eixos=4 tick=${this.tickHz} rx=${this.rx} fila=${this.filaMax} ref=${this.ref ? 1 : 0}`;
  }

  get movendo() {
    return !!this.atual || this.fila.length > 0;
  }

  get estado() {
    if (this.alarme) return 'ALARME';
    if (this.homing) return 'HOMING';
    return this.movendo ? 'MOVENDO' : 'OCIOSO';
  }

  atualizar() {
    const t = this.agora();
    for (;;) {
      if (!this.atual) {
        if (!this.fila.length) break;
        const s = this.fila.shift();
        this.atual = { inicio: Math.max(this.fimUltimo, s.chegada), ms: s.ms, de: [...this.posInt], alvo: s.alvo };
      }
      const a = this.atual;
      if (t >= a.inicio + a.ms) {
        this.posInt = [...a.alvo];
        this.fimUltimo = a.inicio + a.ms;
        this.atual = null;
        continue;
      }
      break;
    }
    if (this.atual) {
      const a = this.atual;
      const u = Math.max(0, (t - a.inicio) / a.ms);
      this.pos = a.de.map((d, i) => d + Math.round((a.alvo[i] - d) * u));
    } else {
      this.pos = [...this.posInt];
      if (this.fimUltimo < t) this.fimUltimo = t;
    }
    this._processarPendentes();
  }

  bufferMs() {
    const t = this.agora();
    let ms = this.atual ? Math.max(0, this.atual.inicio + this.atual.ms - t) : 0;
    for (const s of this.fila) ms += s.ms;
    return ms;
  }

  status() {
    this.atualizar();
    return formatarStatus({
      estado: this.estado,
      alarme: this.alarme,
      passos: this.pos,
      fila: this.fila.length + (this.atual ? 1 : 0),
      bufferMs: this.bufferMs(),
      fins: this.fins,
      motores: this.motores,
      ref: this.ref,
    });
  }

  emergencia(codigo = 1) {
    this.atualizar();
    this.fila = [];
    this.atual = null;
    this.posInt = [...this.pos];
    this.ultimoAlvo = [...this.pos];
    this.homing = null;
    this.alarme = codigo;
    this.enviar(`ALARME ${codigo} parada de emergencia`);
  }

  receberLinha(linha) {
    this.pendentes.push(linha.trim());
    this.atualizar();
  }

  _processarPendentes() {
    while (this.pendentes.length) {
      const r = this._executar(this.pendentes[0]);
      if (r === ADIAR) break;
      this.pendentes.shift();
      if (r) this.enviar(r);
    }
  }

  _enfileirar(alvo, ms) {
    // mesmas travas do firmware: no máximo 1 passo por tick e velocidade máxima por eixo
    let msMin = ms;
    alvo.forEach((p, i) => {
      const d = Math.abs(p - this.ultimoAlvo[i]);
      msMin = Math.max(msMin, (d / this.tickHz) * 1000, (d / this.vmax[i]) * 1000);
    });
    this.fila.push({ alvo: [...alvo], ms: msMin, chegada: this.agora() });
    this.ultimoAlvo = [...alvo];
  }

  _executar(linha) {
    const [cmd, ...args] = linha.split(/\s+/);
    const n = args.map(Number);
    const numerosOk = (k) => n.length === k && n.every(Number.isFinite);
    switch (cmd) {
      case '':
        return null;
      case 'V':
        this.enviar(this.hello());
        return 'ok';
      case 'S':
        if (!numerosOk(5)) return 'erro 2';
        if (this.alarme) return 'erro 3';
        if (!this.motores) return 'erro 6';
        if (this.homing) return ADIAR;
        if (this.fila.length >= this.filaMax) return ADIAR;
        this._enfileirar(n.slice(1), Math.max(n[0] / 1000, 1000 / this.tickHz));
        return 'ok';
      case 'Z':
        if (!numerosOk(4)) return 'erro 2';
        if (this.movendo) return ADIAR;
        this.posInt = [...n];
        this.pos = [...n];
        this.ultimoAlvo = [...n];
        this.ref = true;
        return 'ok';
      case 'E':
        if (!numerosOk(1)) return 'erro 2';
        if (this.movendo) return ADIAR;
        this.motores = n[0] === 1;
        return 'ok';
      case 'M':
        if (!numerosOk(4) || n.some((v) => v <= 0)) return 'erro 2';
        this.vmax = [...n];
        return 'ok';
      case 'L':
        return numerosOk(2) ? 'ok' : 'erro 2';
      case 'X':
        this.alarme = 0;
        return 'ok';
      case 'W':
        return this.movendo ? ADIAR : 'ok';
      case 'H':
        return this._homing(n);
      default:
        return 'erro 1';
    }
  }

  // Homing simulado: a chave virtual fica exatamente na posição "home" informada.
  _homing(n) {
    if (n.length !== 7 || !n.every(Number.isFinite)) return 'erro 2';
    const [eixo, , vRap, vLenta, recuo, curso, home] = n;
    if (this.alarme) return 'erro 3';
    if (!this.motores) return 'erro 6';
    if (eixo < 0 || eixo > 3) return 'erro 2';
    if (!this.homing) {
      if (this.movendo) return ADIAR;
      const dist = Math.abs(home - this.pos[eixo]);
      if (dist > curso) {
        this.alarme = 3;
        this.enviar('ALARME 3 homing falhou');
        return 'erro 4';
      }
      this.homing = { eixo };
      const alvo = [...this.pos];
      alvo[eixo] = home;
      this._enfileirar(alvo, (dist / vRap) * 1000);
      const recuado = [...alvo];
      recuado[eixo] = home - Math.sign(home - this.pos[eixo] || 1) * recuo;
      this._enfileirar(recuado, (recuo / vLenta) * 1000);
      this._enfileirar(alvo, (recuo / vLenta) * 1000);
      return ADIAR;
    }
    if (this.movendo) return ADIAR;
    this.homing = null;
    this.ref = true;
    return 'ok';
  }
}

/** Transporte com a mesma interface do serial, ligado a um FirmwareVirtual. */
export class TransporteSimulado {
  constructor(opts = {}) {
    this.opts = opts;
    this.agora = opts.agora ?? (() => performance.now());
    this.aoReceber = null;
    this.aoFechar = null;
    this.nome = 'Simulador';
  }

  async abrir() {
    this.fw = new FirmwareVirtual({ ...this.opts, agora: this.agora, enviar: (l) => this._entregar(l) });
    this._buffer = '';
    if (this.opts.relogioManual !== true) this._intervalo = setInterval(() => this.fw.atualizar(), 4);
    setTimeout(() => this._entregar(this.fw.hello()), 30);
  }

  _entregar(linha) {
    // entrega assíncrona e em ordem, como uma porta serial
    queueMicrotask(() => this.aoReceber?.(linha));
  }

  async escrever(texto) {
    if (!this.fw) throw new Error('simulador fechado');
    for (const ch of texto) {
      if (ch === '?') this._entregar(this.fw.status());
      else if (ch === '!') this.fw.emergencia(1);
      else if (ch === '\n') {
        const l = this._buffer;
        this._buffer = '';
        this.fw.receberLinha(l);
      } else if (ch !== '\r') this._buffer += ch;
    }
  }

  async fechar() {
    clearInterval(this._intervalo);
    this.fw = null;
  }
}
