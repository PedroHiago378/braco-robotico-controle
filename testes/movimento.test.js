import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cinematica } from '../src/nucleo/cinematica.js';
import { configPadrao } from '../src/nucleo/config.js';
import { planejarJunta, planejarLinear } from '../src/nucleo/trajetoria.js';
import { Timeline } from '../src/nucleo/timeline.js';

const cfg = configPadrao();
const cin = new Cinematica(cfg.geometria);
const J = cfg.juntas;
const ctx = { cin, juntas: J };

function picos(amostrar, T, dt = 0.001) {
  let qa = amostrar(0);
  let va = qa.map(() => 0);
  const v = [0, 0, 0, 0];
  const a = [0, 0, 0, 0];
  for (let t = dt; t <= T + 1e-12; t += dt) {
    const q = amostrar(t);
    const vi = q.map((x, i) => (x - qa[i]) / dt);
    vi.forEach((x, i) => {
      v[i] = Math.max(v[i], Math.abs(x));
      a[i] = Math.max(a[i], Math.abs(x - va[i]) / dt);
    });
    qa = q;
    va = vi;
  }
  return { v, a };
}

test('movimento de junta sincronizado respeita velMax e accMax', () => {
  const q0 = [0, 60, -60, 0];
  const q1 = [120, 20, 45, -90];
  const p = planejarJunta(q0, q1, J);
  assert.deepEqual(p.amostrar(0), q0);
  p.amostrar(p.T).forEach((v, i) => assert.ok(Math.abs(v - q1[i]) < 1e-9));
  const { v, a } = picos(p.amostrar, p.T);
  v.forEach((x, i) => assert.ok(x <= J[i].velMax * 1.001, `vel junta ${i}: ${x}`));
  a.forEach((x, i) => assert.ok(x <= J[i].accMax * 1.01, `acc junta ${i}: ${x}`));
});

test('movimento linear mantém a ponta na reta', () => {
  const q0 = [0, 60, -60, -30];
  const p0 = cin.pose(q0);
  const alvo = { x: p0.x - 40, y: p0.y + 120, z: p0.z - 60, phi: p0.phi };
  const p = planejarLinear(cin, J, cfg.controle, q0, alvo);
  assert.ok(!p.erro, p.erro);
  const d = [alvo.x - p0.x, alvo.y - p0.y, alvo.z - p0.z];
  const n = Math.hypot(...d);
  for (let t = 0; t <= p.T; t += p.T / 50) {
    const pt = cin.pose(p.amostrar(t));
    const w = [pt.x - p0.x, pt.y - p0.y, pt.z - p0.z];
    const proj = (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / n;
    const dist = Math.sqrt(Math.max(0, w[0] ** 2 + w[1] ** 2 + w[2] ** 2 - proj ** 2));
    assert.ok(dist < 0.05, `desvio da reta ${dist} mm em t=${t}`);
  }
  const fim = cin.pose(p.amostrar(p.T));
  assert.ok(Math.hypot(fim.x - alvo.x, fim.y - alvo.y, fim.z - alvo.z) < 1e-6);
});

test('timeline: amostra nos keyframes, spline monotônica não ultrapassa', () => {
  const tl = new Timeline();
  tl.adicionar(0, [0, 60, -60, 0], 'spline');
  tl.adicionar(2, [40, 70, -50, 10], 'spline');
  tl.adicionar(4, [80, 70, -40, 20], 'spline');
  tl.adicionar(6, [80, 50, -40, 0], 'suave');
  assert.deepEqual(tl.amostrar(2, ctx), [40, 70, -50, 10]);
  assert.deepEqual(tl.amostrar(10, ctx), [80, 50, -40, 0]);
  // ombro: 60 -> 70 -> 70 : não pode passar de 70 entre 2 e 4
  for (let t = 2; t <= 4; t += 0.05) assert.ok(tl.amostrar(t, ctx)[1] <= 70 + 1e-9);
});

test('timeline: validação acusa segmento rápido e corrigirTempos resolve', () => {
  const tl = new Timeline();
  tl.adicionar(0, [0, 60, -60, 0], 'suave');
  tl.adicionar(0.5, [90, 60, -60, 0], 'suave'); // 90° em 0,5 s: muito rápido para a base
  tl.adicionar(1.5, [90, 40, -30, 0], 'suave');
  const r = tl.validar(ctx, cfg);
  assert.ok(!r.ok);
  assert.ok(r.problemas.some((p) => p.tipo === 'velocidade' && p.junta === 0));
  const c = tl.corrigirTempos(ctx, cfg);
  assert.ok(c.ok, JSON.stringify(c.restantes));
  assert.ok(tl.keyframes[1].t > 0.5);
});

test('timeline: segmento cartesiano anda em reta', () => {
  const tl = new Timeline();
  const qa = [0, 60, -60, -30];
  const pa = cin.pose(qa);
  const qb = cin.melhorSolucao({ ...pa, y: pa.y + 100 }, qa, J).q;
  tl.adicionar(0, qa, 'cartesiana');
  tl.adicionar(3, qb, 'suave');
  for (let t = 0; t <= 3; t += 0.1) {
    const p = cin.pose(tl.amostrar(t, ctx));
    assert.ok(Math.abs(p.x - pa.x) < 1e-6 && Math.abs(p.z - pa.z) < 1e-6);
  }
});

test('timeline: JSON ida e volta', () => {
  const tl = new Timeline('teste');
  tl.adicionar(0, [0, 60, -60, 0]);
  tl.adicionar(1.25, [10, 50, -40, 5], 'spline', 'pega');
  const tl2 = new Timeline();
  tl2.carregarJSON(JSON.parse(JSON.stringify(tl.paraJSON())));
  assert.equal(tl2.nome, 'teste');
  assert.equal(tl2.keyframes[1].nome, 'pega');
  assert.equal(tl2.keyframes[1].interp, 'spline');
  assert.deepEqual(tl2.keyframes[1].q, [10, 50, -40, 5]);
});
