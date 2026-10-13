// Cinemática direta e inversa do braço RRRR: yaw na base + 3 juntas de pitch paralelas.
//
// Frame do robô: origem no eixo da base, sobre a mesa; z para cima.
// O ombro fica em (offsetOmbro, 0, alturaOmbro) no plano do braço, girado por q1.
// Ângulos (graus): q = [q1, t1, t2, t3]
//   q1: yaw da base
//   t1: ombro, absoluto a partir da horizontal (positivo para cima)
//   t2: cotovelo, relativo ao elo 1
//   t3: punho, relativo ao elo 2
// phi: elevação da ferramenta em relação à horizontal, medida a partir da direção radial
//      "para fora" (do eixo da base em direção à ponta). 0 = horizontal para fora,
//      -90 = para baixo, +90 = para cima, 180 = horizontal apontando para a base.

import { RAD, GRAUS, clamp, wrap180 } from './util.js';

/** Todas as variantes q + 360k (por junta) que caem dentro dos limites. */
export function variantesNosLimites(q, juntas, tol = 1e-6) {
  let res = [[]];
  for (let i = 0; i < q.length; i++) {
    const j = juntas[i];
    const ops = [];
    for (let k = -2; k <= 2; k++) {
      const w = q[i] + 360 * k;
      if (w >= j.min - tol && w <= j.max + tol) ops.push(clamp(w, j.min, j.max));
    }
    if (!ops.length) return [];
    const nr = [];
    for (const r of res) for (const v of ops) nr.push([...r, v]);
    res = nr;
  }
  return res;
}

export function dentroDosLimites(q, juntas, tol = 1e-6) {
  return q.every((v, i) => v >= juntas[i].min - tol && v <= juntas[i].max + tol);
}

export class Cinematica {
  constructor(geometria) {
    this.definirGeometria(geometria);
  }

  definirGeometria(g) {
    this.g = { ...g };
  }

  /** Pontos no plano do braço: r (radial ao longo de q1) e z relativo ao ombro. */
  plano(q) {
    const { offsetOmbro: a, L1, L2, L3 } = this.g;
    const p1 = q[1] * RAD;
    const p2 = p1 + q[2] * RAD;
    const p3 = p2 + q[3] * RAD;
    const rE = a + L1 * Math.cos(p1);
    const zE = L1 * Math.sin(p1);
    const rW = rE + L2 * Math.cos(p2);
    const zW = zE + L2 * Math.sin(p2);
    const rT = rW + L3 * Math.cos(p3);
    const zT = zW + L3 * Math.sin(p3);
    return { rS: a, zS: 0, rE, zE, rW, zW, rT, zT, f: p3 };
  }

  /** Cinemática direta completa: pontos 3D de cada junta, pose da ponta. */
  direta(q) {
    const h = this.g.alturaOmbro;
    const p = this.plano(q);
    const c = Math.cos(q[0] * RAD);
    const s = Math.sin(q[0] * RAD);
    const P = (r, z) => [r * c, r * s, z + h];
    const sinal = p.rT >= -1e-9 ? 1 : -1;
    const phi = Math.atan2(Math.sin(p.f), sinal * Math.cos(p.f)) * GRAUS;
    const ponta = P(p.rT, p.zT);
    return {
      pontos: {
        base: [0, 0, 0],
        ombro: P(p.rS, p.zS),
        cotovelo: P(p.rE, p.zE),
        punho: P(p.rW, p.zW),
        ponta,
      },
      ponta,
      phi,
      rho: p.rT,
      plano: p,
    };
  }

  pose(q) {
    const d = this.direta(q);
    return { x: d.ponta[0], y: d.ponta[1], z: d.ponta[2], phi: d.phi };
  }

  /** Classifica a configuração de q: ramo da base e do cotovelo. */
  ramos(q) {
    const p = this.plano(q);
    const frente = p.rT >= 0;
    return {
      ramoBase: frente ? 'frente' : 'atras',
      ramoCotovelo: q[2] < 0 === frente ? 'cima' : 'baixo',
    };
  }

  /**
   * Cinemática inversa analítica. alvo = {x, y, z, phi} (mm, graus).
   * Retorna até 4 soluções {q, ramoBase, ramoCotovelo}, sem filtrar limites.
   * q1Ref é usado quando a ponta está sobre o eixo da base (q1 indeterminado).
   */
  inversa(alvo, q1Ref = 0) {
    const { alturaOmbro: h, offsetOmbro: a, L1, L2, L3 } = this.g;
    const z = alvo.z - h;
    const phi = alvo.phi * RAD;
    const R = Math.hypot(alvo.x, alvo.y);
    const az = R > 1e-6 ? Math.atan2(alvo.y, alvo.x) : q1Ref * RAD;
    const sols = [];
    for (const [ramoBase, q1, sinal] of [
      ['frente', az, 1],
      ['atras', az + Math.PI, -1],
    ]) {
      const rho = sinal * R;
      const phiP = Math.atan2(Math.sin(phi), sinal * Math.cos(phi));
      const dr = rho - L3 * Math.cos(phiP) - a;
      const dz = z - L3 * Math.sin(phiP);
      let c2 = (dr * dr + dz * dz - L1 * L1 - L2 * L2) / (2 * L1 * L2);
      if (Math.abs(c2) > 1 + 1e-9) continue;
      c2 = clamp(c2, -1, 1);
      for (const sg of [-1, 1]) {
        const t2 = sg * Math.acos(c2);
        const t1 = Math.atan2(dz, dr) - Math.atan2(L2 * Math.sin(t2), L1 + L2 * Math.cos(t2));
        const t3 = phiP - t1 - t2;
        // No ramo "atrás" o plano é espelhado: cotovelo para cima corresponde a t2 > 0.
        const cima = sinal > 0 ? sg < 0 : sg > 0;
        sols.push({
          q: [wrap180(q1 * GRAUS), wrap180(t1 * GRAUS), t2 * GRAUS, wrap180(t3 * GRAUS)],
          ramoBase,
          ramoCotovelo: cima ? 'cima' : 'baixo',
        });
      }
    }
    return sols;
  }

  /**
   * Melhor solução dentro dos limites, mais próxima de qRef.
   * opts: { ramoCotovelo: 'auto'|'cima'|'baixo', ramoBase: 'auto'|'frente'|'atras', pesos }
   */
  melhorSolucao(alvo, qRef, juntas, opts = {}) {
    const { ramoCotovelo = 'auto', ramoBase = 'auto', pesos = [1, 1, 1, 1] } = opts;
    let melhor = null;
    for (const s of this.inversa(alvo, qRef[0])) {
      if (ramoCotovelo !== 'auto' && s.ramoCotovelo !== ramoCotovelo) continue;
      if (ramoBase !== 'auto' && s.ramoBase !== ramoBase) continue;
      for (const q of variantesNosLimites(s.q, juntas)) {
        let custo = 0;
        for (let i = 0; i < q.length; i++) custo += pesos[i] * Math.abs(q[i] - qRef[i]);
        if (!melhor || custo < melhor.custo)
          melhor = { q, custo, ramoBase: s.ramoBase, ramoCotovelo: s.ramoCotovelo };
      }
    }
    return melhor;
  }

  /**
   * Resolve um alvo. Com opts.phiLivre, se phi exato for inalcançável, procura o phi
   * alcançável mais próximo. Retorna {q, phi, exato, ramoBase, ramoCotovelo} ou null.
   */
  resolver(alvo, qRef, juntas, opts = {}) {
    const exato = this.melhorSolucao(alvo, qRef, juntas, opts);
    if (exato) return { ...exato, phi: alvo.phi, exato: true };
    if (!opts.phiLivre) return null;
    const tenta = (phi) => this.melhorSolucao({ ...alvo, phi }, qRef, juntas, opts);
    const passo = 2;
    for (let d = passo; d <= 180; d += passo) {
      for (const s of [1, -1]) {
        const phi = alvo.phi + s * d;
        if (!tenta(phi)) continue;
        let ok = phi;
        let ruim = phi - s * passo;
        for (let k = 0; k < 14; k++) {
          const m = (ok + ruim) / 2;
          if (tenta(m)) ok = m;
          else ruim = m;
        }
        return { ...tenta(ok), phi: wrap180(ok), exato: false };
      }
    }
    return null;
  }

  /** Jacobiano 3×4 da posição da ponta, d(x,y,z)/dq em mm/grau (diferença central). */
  jacobiano(q, eps = 1e-3) {
    const J = [[], [], []];
    for (let i = 0; i < 4; i++) {
      const qa = [...q];
      const qb = [...q];
      qa[i] += eps;
      qb[i] -= eps;
      const a = this.direta(qa).ponta;
      const b = this.direta(qb).ponta;
      for (let k = 0; k < 3; k++) J[k][i] = (a[k] - b[k]) / (2 * eps);
    }
    return J;
  }

  /** Indicadores de singularidade: cotovelo esticado e punho sobre o eixo da base. */
  singularidade(q) {
    const p = this.plano(q);
    const cot = Math.abs(Math.sin(q[2] * RAD));
    const eixo = Math.abs(p.rW);
    const avisos = [];
    if (cot < 0.06) avisos.push('Cotovelo quase esticado/dobrado (singularidade)');
    if (eixo < 25) avisos.push('Punho perto do eixo da base (base indeterminada)');
    return { cotovelo: cot, eixo, avisos };
  }

  /**
   * Região alcançável da ponta no plano do braço, para a ferramenta com elevação phi.
   * Retorna array plano [r0, z0, r1, z1, ...] (z absoluto, mm).
   */
  fatiaAlcance(juntas, phiDeg, passo = 2) {
    const { alturaOmbro: h, offsetOmbro: a, L1, L2, L3 } = this.g;
    const [, j1, j2, j3] = juntas;
    const pts = [];
    const fs = [phiDeg, 180 - phiDeg];
    const cf = fs.map((f) => Math.cos(f * RAD));
    const sf = fs.map((f) => Math.sin(f * RAD));
    for (let t1 = j1.min; t1 <= j1.max + 1e-9; t1 += passo) {
      const p1 = t1 * RAD;
      for (let t2 = j2.min; t2 <= j2.max + 1e-9; t2 += passo) {
        const p2 = p1 + t2 * RAD;
        const wr = a + L1 * Math.cos(p1) + L2 * Math.cos(p2);
        const wz = L1 * Math.sin(p1) + L2 * Math.sin(p2);
        for (let k = 0; k < 2; k++) {
          const tr = wr + L3 * cf[k];
          if (k === 0 ? tr < 0 : tr > 0) continue;
          const t3 = wrap180(fs[k] - t1 - t2);
          if (!(t3 >= j3.min && t3 <= j3.max) && !(t3 + 360 <= j3.max) && !(t3 - 360 >= j3.min)) continue;
          pts.push(tr, wz + L3 * sf[k] + h);
        }
      }
    }
    return pts;
  }
}
