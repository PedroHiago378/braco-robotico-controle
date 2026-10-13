// Timeline de keyframes: cada keyframe guarda os 4 ângulos e o modo de interpolação
// do segmento que SAI dele até o próximo keyframe.

import { Emissor, difAngular, quaseIgual } from './util.js';
import { suave5, hermite } from './perfis.js';
import { torquesEstaticos } from './torque.js';

export const INTERPOLACOES = {
  suave: 'Suave (para no keyframe)',
  spline: 'Spline (passa direto)',
  linear: 'Linear (velocidade constante)',
  cartesiana: 'Linear cartesiana (ponta em reta)',
};

const NOMES_PROBLEMA = {
  velocidade: 'velocidade',
  aceleracao: 'aceleração',
  limite: 'limite da junta',
  torque: 'torque estático',
  alcance: 'fora do alcance',
  ramo: 'mudança de configuração',
};

let proximoId = 1;
const arred = (t) => Math.round(t * 1000) / 1000;

export class Timeline extends Emissor {
  constructor(nome = 'Programa') {
    super();
    this.nome = nome;
    this.keyframes = [];
    this._tangentes = null;
  }

  _mudou() {
    this._tangentes = null;
    this.emit('mudou');
  }

  get duracao() {
    const k = this.keyframes;
    return k.length ? k[k.length - 1].t : 0;
  }

  porId(id) {
    return this.keyframes.find((k) => k.id === id) ?? null;
  }

  _ordenar() {
    this.keyframes.sort((a, b) => a.t - b.t);
  }

  /** Adiciona um keyframe; se já houver um no mesmo instante, substitui a pose. */
  adicionar(t, q, interp = 'suave', nome) {
    t = Math.max(0, arred(t));
    const existente = this.keyframes.find((k) => Math.abs(k.t - t) < 1e-3);
    if (existente) {
      existente.q = [...q];
      this._mudou();
      return existente;
    }
    const kf = { id: proximoId++, t, q: [...q], interp, nome: nome ?? `KF ${this.keyframes.length + 1}` };
    this.keyframes.push(kf);
    this._ordenar();
    this._mudou();
    return kf;
  }

  remover(id) {
    const n = this.keyframes.length;
    this.keyframes = this.keyframes.filter((k) => k.id !== id);
    if (this.keyframes.length !== n) this._mudou();
  }

  /** Atualiza campos (t, q, interp, nome). Tempo colidindo com outro keyframe é deslocado 1 ms. */
  atualizar(id, campos) {
    const kf = this.porId(id);
    if (!kf) return null;
    if (campos.q) kf.q = [...campos.q];
    if (campos.interp) kf.interp = campos.interp;
    if (campos.nome !== undefined) kf.nome = campos.nome;
    if (campos.t !== undefined) {
      let t = Math.max(0, arred(campos.t));
      while (this.keyframes.some((k) => k !== kf && Math.abs(k.t - t) < 1e-3)) t = arred(t + 0.001);
      kf.t = t;
      this._ordenar();
    }
    this._mudou();
    return kf;
  }

  limpar() {
    this.keyframes = [];
    this._mudou();
  }

  /** Índice i do segmento com keyframes[i].t <= t < keyframes[i+1].t. */
  indiceSegmento(t) {
    const K = this.keyframes;
    if (K.length < 2 || t <= K[0].t) return 0;
    if (t >= K[K.length - 1].t) return K.length - 2;
    let lo = 0;
    let hi = K.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (K[m].t <= t) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** Tangentes (°/s) por keyframe e junta, para segmentos spline (Hermite monotônica). */
  tangentes() {
    if (this._tangentes) return this._tangentes;
    const K = this.keyframes;
    const n = K.length;
    this._tangentes = K.map((kf, i) => {
      const ant = i > 0 ? K[i - 1] : null;
      const dep = i < n - 1 ? K[i + 1] : null;
      const modoAnt = ant ? ant.interp : null;
      const modoDep = dep ? kf.interp : null;
      return kf.q.map((qi, j) => {
        const hA = ant ? kf.t - ant.t : 0;
        const hD = dep ? dep.t - kf.t : 0;
        const sA = ant && hA > 0 ? (qi - ant.q[j]) / hA : 0;
        const sD = dep && hD > 0 ? (dep.q[j] - qi) / hD : 0;
        if (modoAnt === 'spline' && modoDep === 'spline') {
          if (sA * sD <= 0) return 0;
          let m = (sA * hD + sD * hA) / (hA + hD);
          const lim = 3 * Math.min(Math.abs(sA), Math.abs(sD));
          if (Math.abs(m) > lim) m = Math.sign(m) * lim;
          return m;
        }
        if (modoAnt === 'spline' && modoDep === 'linear') return sD;
        if (modoAnt === 'linear' && modoDep === 'spline') return sA;
        return 0;
      });
    });
    return this._tangentes;
  }

  /** Pose (ângulos) no instante t. ctx = {cin, juntas} é necessário para segmentos cartesianos. */
  amostrar(t, ctx) {
    return this._amostrar(t, ctx).q;
  }

  _amostrar(t, ctx) {
    const K = this.keyframes;
    if (!K.length) return { q: null };
    if (t <= K[0].t) return { q: [...K[0].q] };
    const ult = K[K.length - 1];
    if (t >= ult.t) return { q: [...ult.q] };
    const i = this.indiceSegmento(t);
    const a = K[i];
    const b = K[i + 1];
    const h = b.t - a.t;
    const u = (t - a.t) / h;
    switch (a.interp) {
      case 'linear':
        return { q: a.q.map((v, j) => v + (b.q[j] - v) * u) };
      case 'spline': {
        const M = this.tangentes();
        return { q: a.q.map((v, j) => hermite(v, b.q[j], M[i][j], M[i + 1][j], u, h)) };
      }
      case 'cartesiana': {
        const s = suave5(u);
        const q = ctx ? this._cartesiana(a, b, s, ctx) : null;
        if (q) return { q };
        return { q: a.q.map((v, j) => v + (b.q[j] - v) * s), falhou: !!ctx };
      }
      default: {
        const s = suave5(u);
        return { q: a.q.map((v, j) => v + (b.q[j] - v) * s) };
      }
    }
  }

  _cartesiana(a, b, s, ctx) {
    const pa = ctx.cin.pose(a.q);
    const pb = ctx.cin.pose(b.q);
    const pose = {
      x: pa.x + (pb.x - pa.x) * s,
      y: pa.y + (pb.y - pa.y) * s,
      z: pa.z + (pb.z - pa.z) * s,
      phi: pa.phi + difAngular(pa.phi, pb.phi) * s,
    };
    const qRef = a.q.map((v, j) => v + (b.q[j] - v) * s);
    const sol = ctx.cin.melhorSolucao(pose, qRef, ctx.juntas, ctx.cin.ramos(a.q));
    return sol ? sol.q : null;
  }

  /**
   * Verifica a timeline amostrando no período de controle (como o firmware executa).
   * Retorna { ok, problemas: [{seg, t0, t1, tipo, junta, razao, msg}], picosV, picosA, pontas }.
   */
  validar(ctx, config) {
    const K = this.keyframes;
    const juntas = config.juntas;
    const pior = new Map();
    const registrar = (seg, tipo, razao, junta) => {
      const chave = `${seg}|${tipo}|${junta}`;
      const atual = pior.get(chave);
      if (!atual || razao > atual.razao) pior.set(chave, { seg, tipo, razao, junta });
    };
    const picosV = [0, 0, 0, 0];
    const picosA = [0, 0, 0, 0];
    const pontas = [];
    if (K.length < 2) return { ok: true, problemas: [], picosV, picosA, pontas };

    for (let i = 0; i < K.length - 1; i++) {
      if (K[i].interp !== 'cartesiana') continue;
      const ra = ctx.cin.ramos(K[i].q);
      const rb = ctx.cin.ramos(K[i + 1].q);
      if (ra.ramoBase !== rb.ramoBase || ra.ramoCotovelo !== rb.ramoCotovelo) registrar(i, 'ramo', 1, -1);
    }

    const dt = 1 / config.controle.taxaHz;
    const T = this.duracao;
    let tPrev = K[0].t;
    let qPrev = [...K[0].q];
    let vPrev = [0, 0, 0, 0];
    pontas.push(ctx.cin.direta(qPrev).ponta);
    const verificarAcc = (seg, v, h) =>
      v.forEach((vi, j) => {
        const a = Math.abs(vi - vPrev[j]) / h;
        picosA[j] = Math.max(picosA[j], a);
        if (a > juntas[j].accMax * 1.001) registrar(seg, 'aceleracao', a / juntas[j].accMax, j);
      });

    for (let k = 1; tPrev < T - 1e-9; k++) {
      const t = Math.min(K[0].t + k * dt, T);
      const h = t - tPrev;
      const seg = this.indiceSegmento(t - h / 2);
      const r = this._amostrar(t, ctx);
      const q = r.q;
      if (r.falhou) registrar(seg, 'alcance', 1, -1);
      const v = q.map((qi, j) => (qi - qPrev[j]) / h);
      v.forEach((vi, j) => {
        picosV[j] = Math.max(picosV[j], Math.abs(vi));
        if (Math.abs(vi) > juntas[j].velMax * 1.001) registrar(seg, 'velocidade', Math.abs(vi) / juntas[j].velMax, j);
      });
      verificarAcc(seg, v, h);
      q.forEach((qi, j) => {
        const jt = juntas[j];
        if (qi < jt.min - 1e-6 || qi > jt.max + 1e-6) registrar(seg, 'limite', 1, j);
      });
      const tau = torquesEstaticos(ctx.cin, q, config.massas);
      for (let j = 1; j < 4; j++) {
        const cap = config.massas.capacidade[j];
        if (Math.abs(tau[j]) > cap) registrar(seg, 'torque', Math.abs(tau[j]) / cap, j);
      }
      pontas.push(ctx.cin.direta(q).ponta);
      tPrev = t;
      qPrev = q;
      vPrev = v;
    }
    // parada no fim
    verificarAcc(K.length - 2, [0, 0, 0, 0], dt);

    const problemas = [...pior.values()]
      .map((p) => {
        const nomeJ = p.junta >= 0 ? juntas[p.junta].nome : '';
        const extra = ['velocidade', 'aceleracao', 'torque'].includes(p.tipo) ? ` (${(p.razao * 100).toFixed(0)}% do máximo)` : '';
        return {
          ...p,
          t0: K[p.seg].t,
          t1: K[p.seg + 1].t,
          msg: `${K[p.seg].nome} → ${K[p.seg + 1].nome}: ${NOMES_PROBLEMA[p.tipo]}${nomeJ ? ' em ' + nomeJ : ''}${extra}`,
        };
      })
      .sort((a, b) => a.t0 - b.t0 || b.razao - a.razao);
    return { ok: problemas.length === 0, problemas, picosV, picosA, pontas };
  }

  /**
   * Estica os segmentos com excesso de velocidade/aceleração até caberem nos limites.
   * Retorna { ok, iteracoes, restantes }.
   */
  corrigirTempos(ctx, config, maxIter = 15) {
    let r = this.validar(ctx, config);
    let it = 0;
    for (; it < maxIter && !r.ok; it++) {
      const fatores = new Map();
      for (const p of r.problemas) {
        let f;
        if (p.tipo === 'velocidade') f = p.razao;
        else if (p.tipo === 'aceleracao') f = Math.sqrt(p.razao);
        else continue;
        fatores.set(p.seg, Math.max(fatores.get(p.seg) ?? 1, Math.min(f * 1.05, 3)));
      }
      if (!fatores.size) break;
      const K = this.keyframes;
      const novos = [K[0].t];
      for (let i = 0; i < K.length - 1; i++) novos.push(novos[i] + (K[i + 1].t - K[i].t) * (fatores.get(i) ?? 1));
      K.forEach((k, i) => (k.t = arred(novos[i])));
      this._mudou();
      r = this.validar(ctx, config);
    }
    return { ok: r.ok, iteracoes: it, restantes: r.problemas };
  }

  /** True se o fim e o início têm a mesma pose (loop sem transição). */
  loopContinuo(tol = 0.05) {
    const K = this.keyframes;
    return K.length > 1 && quaseIgual(K[0].q, K[K.length - 1].q, tol);
  }

  paraJSON() {
    return {
      formato: 'braco-timeline',
      versao: 1,
      nome: this.nome,
      keyframes: this.keyframes.map(({ t, q, interp, nome }) => ({ t, q: q.map((v) => +v.toFixed(4)), interp, nome })),
    };
  }

  carregarJSON(obj) {
    if (!obj || !Array.isArray(obj.keyframes)) throw new Error('Arquivo de timeline inválido');
    this.nome = obj.nome ?? 'Programa';
    this.keyframes = obj.keyframes.map((k, i) => {
      if (!Array.isArray(k.q) || k.q.length !== 4 || k.q.some((v) => typeof v !== 'number'))
        throw new Error(`Keyframe ${i + 1} inválido`);
      return {
        id: proximoId++,
        t: Math.max(0, arred(+k.t || 0)),
        q: [...k.q],
        interp: INTERPOLACOES[k.interp] ? k.interp : 'suave',
        nome: k.nome ?? `KF ${i + 1}`,
      };
    });
    this._ordenar();
    this._mudou();
  }
}
