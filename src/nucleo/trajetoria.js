// Planejadores de movimento ponto a ponto.
// Todo plano devolve { T (s), amostrar(t) -> q } ou { erro }.

import { perfilTrapezoidal } from './perfis.js';
import { difAngular } from './util.js';

/**
 * Movimento de junta sincronizado: todas as juntas saem e chegam juntas, em linha reta
 * no espaço de juntas, com perfil trapezoidal que respeita velMax/accMax de cada uma.
 */
export function planejarJunta(q0, q1, juntas, fator = 1) {
  const d = q1.map((v, i) => v - q0[i]);
  let V = Infinity;
  let A = Infinity;
  d.forEach((di, i) => {
    const ad = Math.abs(di);
    if (ad < 1e-9) return;
    V = Math.min(V, (juntas[i].velMax * fator) / ad);
    A = Math.min(A, (juntas[i].accMax * fator) / ad);
  });
  if (!Number.isFinite(V)) return { T: 0, amostrar: () => [...q1] };
  const p = perfilTrapezoidal(V, A);
  return { T: p.T, amostrar: (t) => q0.map((v, i) => v + d[i] * p.s(t)) };
}

/**
 * Movimento linear da ponta (x, y, z) com phi interpolado, perfil trapezoidal cartesiano.
 * Mantém o ramo do cotovelo e da base de q0. Se alguma junta passar do limite de
 * velocidade/aceleração, o movimento é desacelerado até caber.
 */
export function planejarLinear(cin, juntas, controle, q0, alvo, opts = {}) {
  const fator = opts.fator ?? 1;
  const taxaHz = opts.taxaHz ?? 50;
  const p0 = cin.pose(q0);
  const ramos = cin.ramos(q0);
  const fim = cin.melhorSolucao(alvo, q0, juntas, ramos);
  if (!fim) {
    return cin.melhorSolucao(alvo, q0, juntas)
      ? { erro: 'O alvo exige outra configuração (cotovelo/base). Use movimento de junta.' }
      : { erro: 'Alvo fora do alcance ou dos limites das juntas.' };
  }
  const dp = [alvo.x - p0.x, alvo.y - p0.y, alvo.z - p0.z];
  const dist = Math.hypot(...dp);
  const dphi = difAngular(p0.phi, alvo.phi);
  let V = Infinity;
  let A = Infinity;
  if (dist > 1e-6) {
    V = Math.min(V, controle.velCartesiana / dist);
    A = Math.min(A, controle.accCartesiana / dist);
  }
  if (Math.abs(dphi) > 1e-6) {
    V = Math.min(V, controle.velPhi / Math.abs(dphi));
    A = Math.min(A, controle.accPhi / Math.abs(dphi));
  }
  if (!Number.isFinite(V)) return { T: 0, amostrar: () => [...q0] };
  V *= fator;
  A *= fator;

  const dt = 1 / 200;
  const janela = Math.max(1, Math.round(200 / taxaHz)); // aceleração medida no período de controle
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const perfil = perfilTrapezoidal(V, A);
    const n = Math.max(1, Math.ceil(perfil.T / dt));
    const tempos = [0];
    const tabela = [[...q0]];
    const vel = [];
    let razaoV = 0;
    let razaoA = 0;
    let qPrev = q0;
    for (let k = 1; k <= n; k++) {
      const t = Math.min(k * dt, perfil.T);
      const s = perfil.s(t);
      const pose = {
        x: p0.x + dp[0] * s,
        y: p0.y + dp[1] * s,
        z: p0.z + dp[2] * s,
        phi: p0.phi + dphi * s,
      };
      const sol = cin.melhorSolucao(pose, qPrev, juntas, ramos);
      if (!sol) return { erro: `Caminho sai do alcance em ${(100 * s).toFixed(0)}% do percurso.` };
      const h = t - tempos[tempos.length - 1];
      const v = sol.q.map((qi, i) => (qi - qPrev[i]) / h);
      v.forEach((vi, i) => (razaoV = Math.max(razaoV, Math.abs(vi) / (juntas[i].velMax * fator))));
      vel.push(v);
      if (vel.length > janela) {
        const va = vel[vel.length - 1 - janela];
        v.forEach((vi, i) => {
          const a = Math.abs(vi - va[i]) / (janela * dt);
          razaoA = Math.max(razaoA, a / (juntas[i].accMax * fator));
        });
      }
      tempos.push(t);
      tabela.push(sol.q);
      qPrev = sol.q;
    }
    const escala = Math.max(razaoV, Math.sqrt(razaoA));
    if (escala <= 1.0001) {
      return { T: perfil.T, amostrar: (t) => interpolarTabela(tempos, tabela, t) };
    }
    V /= escala * 1.02;
    A /= (escala * 1.02) ** 2;
  }
  return { erro: 'O caminho linear exige velocidade excessiva das juntas (singularidade no caminho).' };
}

function interpolarTabela(tempos, tabela, t) {
  const n = tempos.length - 1;
  if (t <= 0) return [...tabela[0]];
  if (t >= tempos[n]) return [...tabela[n]];
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (tempos[m] <= t) lo = m;
    else hi = m;
  }
  const u = (t - tempos[lo]) / (tempos[hi] - tempos[lo]);
  return tabela[lo].map((v, i) => v + (tabela[hi][i] - v) * u);
}
