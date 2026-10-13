import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cinematica, variantesNosLimites } from '../src/nucleo/cinematica.js';
import { configPadrao } from '../src/nucleo/config.js';
import { torquesEstaticos } from '../src/nucleo/torque.js';

const cfg = configPadrao();
const cin = new Cinematica(cfg.geometria);
const J = cfg.juntas;

function aleatorio(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

test('FK -> IK -> FK recupera a pose em 5000 configurações dentro dos limites', () => {
  const r = aleatorio(7);
  let piorErro = 0;
  let piorJunta = 0;
  for (let n = 0; n < 5000; n++) {
    const q = J.map((j) => j.min + (j.max - j.min) * r());
    const pose = cin.pose(q);
    const sol = cin.melhorSolucao(pose, q, J);
    assert.ok(sol, `sem solução para q=${q}`);
    const p2 = cin.pose(sol.q);
    piorErro = Math.max(piorErro, Math.hypot(p2.x - pose.x, p2.y - pose.y, p2.z - pose.z));
    if (Math.hypot(pose.x, pose.y) > 30) {
      // fora do eixo da base a solução mais próxima é a própria q
      piorJunta = Math.max(piorJunta, ...sol.q.map((v, i) => Math.abs(v - q[i])));
    }
  }
  assert.ok(piorErro < 1e-6, `erro de posição ${piorErro}`);
  assert.ok(piorJunta < 1e-6, `erro de junta ${piorJunta}`);
});

test('confere o exemplo do estudo: alvo (250,150,80), phi=-45 (frame no ombro)', () => {
  const c0 = new Cinematica({ ...cfg.geometria, alturaOmbro: 0 });
  const sols = c0.inversa({ x: 250, y: 150, z: 80, phi: -45 }).filter((s) => s.ramoBase === 'frente');
  const baixo = sols.find((s) => s.ramoCotovelo === 'baixo').q;
  const cima = sols.find((s) => s.ramoCotovelo === 'cima').q;
  const perto = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.06);
  assert.ok(perto(baixo, [31.0, -6.3, 70.8, -109.5]), `cotovelo baixo ${baixo}`);
  assert.ok(perto(cima, [31.0, 64.5, -70.8, -38.7]), `cotovelo cima ${cima}`);
});

test('ramos() concorda com a classificação da IK', () => {
  const r = aleatorio(3);
  for (let n = 0; n < 500; n++) {
    const q = J.map((j) => j.min + (j.max - j.min) * r());
    const pose = cin.pose(q);
    if (Math.hypot(pose.x, pose.y) < 5) continue;
    const ramos = cin.ramos(q);
    const sol = cin.melhorSolucao(pose, q, J, ramos);
    assert.ok(sol, 'a própria configuração deve ser encontrada no seu ramo');
  }
});

test('phi livre encontra a elevação alcançável mais próxima', () => {
  const alvo = { x: 400, y: 0, z: 100, phi: -90 }; // longe demais para a ferramenta apontar para baixo
  assert.equal(cin.resolver(alvo, cfg.poseInicial, J), null);
  const r = cin.resolver(alvo, cfg.poseInicial, J, { phiLivre: true });
  assert.ok(r && !r.exato);
  assert.ok(r.phi > -90 && r.phi < 0, `phi ${r.phi}`);
  const p = cin.pose(r.q);
  assert.ok(Math.hypot(p.x - 400, p.z - 100) < 1e-6);
  assert.ok(Math.abs(p.phi - r.phi) < 1e-6);
});

test('variantes ±360 respeitam limites', () => {
  const jj = [{ min: -270, max: 270 }, ...J.slice(1)];
  const v = variantesNosLimites([170, 0, 0, 0], jj);
  assert.deepEqual(v.map((q) => q[0]).sort((a, b) => a - b), [-190, 170]);
});

test('torque estático do estudo: braço estendido na horizontal, sem carga', () => {
  const t = torquesEstaticos(cin, [0, 0, 0, 0], cfg.massas);
  assert.ok(Math.abs(t[1] - 3.12) < 0.03, `ombro ${t[1]}`);
  assert.ok(Math.abs(t[2] - 1.05) < 0.03, `cotovelo ${t[2]}`);
});
