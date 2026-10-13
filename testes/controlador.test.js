// Ponta a ponta: Controlador -> LinkRobo -> TransporteSimulado (firmware virtual), relógio manual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cinematica } from '../src/nucleo/cinematica.js';
import { configPadrao, grausParaPassos, passosPorGrau } from '../src/nucleo/config.js';
import { Controlador } from '../src/nucleo/controlador.js';
import { Timeline } from '../src/nucleo/timeline.js';
import { LinkRobo } from '../src/hardware/link.js';
import { TransporteSimulado } from '../src/hardware/simulador.js';
import * as op from '../src/nucleo/operacoes.js';

const esperarMicro = () => new Promise((r) => setImmediate(r));

async function montar() {
  const config = configPadrao();
  const cin = new Cinematica(config.geometria);
  let t = 0;
  const agora = () => t;
  const link = new LinkRobo();
  const tr = new TransporteSimulado({ agora, relogioManual: true });
  const ctl = new Controlador({ config, cin, link, agora });
  const app = { config, link, ctl };
  await op.conectar(app, tr);
  await op.ligarMotores(app, true);
  // registra cada segmento enviado
  const segs = [];
  link.on('enviado', (l) => l.startsWith('S ') && segs.push(l.split(' ').slice(1).map(Number)));
  const avancar = async (ms) => {
    for (let k = 0; k < ms / 5; k++) {
      t += 5;
      tr.fw.atualizar();
      ctl.passo();
      await esperarMicro();
    }
  };
  return { config, cin, link, tr, ctl, app, segs, avancar, agora };
}

function verificarSegmentos(config, segs, folga = 1.3) {
  for (const [us, ...p] of segs) assert.ok(us > 0);
  for (let k = 1; k < segs.length; k++) {
    const dt = segs[k][0] / 1e6;
    config.juntas.forEach((j, i) => {
      const v = Math.abs(segs[k][i + 1] - segs[k - 1][i + 1]) / passosPorGrau(j) / dt;
      assert.ok(v <= j.velMax * folga, `junta ${i} a ${v.toFixed(1)} °/s`);
    });
  }
}

test('conecta ao simulador e assume a pose inicial', async () => {
  const { tr, config } = await montar();
  assert.deepEqual(tr.fw.pos, grausParaPassos(config, config.poseInicial));
  assert.equal(tr.fw.motores, true);
});

test('moverJunta chega ao alvo exato no firmware virtual', async () => {
  const { ctl, tr, config, segs, avancar } = await montar();
  const alvo = [45, 80, -30, 20];
  let terminou = false;
  ctl.moverJunta(alvo).then(() => (terminou = true));
  for (let i = 0; i < 400 && !(terminou && !tr.fw.movendo); i++) await avancar(50);
  assert.ok(terminou);
  assert.deepEqual(tr.fw.pos, grausParaPassos(config, alvo));
  verificarSegmentos(config, segs);
});

test('seguir converge sem oscilar e respeita aceleração', async () => {
  const { ctl, tr, config, avancar } = await montar();
  const alvo = [-30, 70, -45, 15];
  ctl.seguir(alvo);
  const vs = [];
  for (let i = 0; i < 200; i++) {
    await avancar(20);
    vs.push([...ctl.vCmd]);
    if (ctl.modo === 'seguir' && !tr.fw.movendo && vs.length > 5 && ctl.vCmd.every((v) => v === 0)) break;
  }
  assert.deepEqual(tr.fw.pos, grausParaPassos(config, alvo));
  const dt = 1 / config.controle.taxaHz;
  for (let k = 1; k < vs.length; k++)
    config.juntas.forEach((j, i) => assert.ok(Math.abs(vs[k][i] - vs[k - 1][i]) / 0.02 <= j.accMax * 2.5 + 1e-6));
  assert.ok(dt > 0);
});

test('executa timeline, pausa com rampa e retoma até o fim', async () => {
  const { ctl, tr, config, cin, segs, avancar } = await montar();
  const tl = new Timeline();
  tl.adicionar(0, [0, 60, -60, 0], 'spline');
  tl.adicionar(2, [30, 70, -50, 10], 'spline');
  tl.adicionar(4, [60, 60, -40, 0], 'suave');
  const ctx = { cin, juntas: config.juntas };
  let fim = null;
  ctl.executarTimeline(tl, ctx).then((r) => (fim = r));
  await avancar(1500);
  assert.equal(ctl.modo, 'timeline');
  ctl.pausar();
  await avancar(1500);
  const tauPausado = ctl.fonte.tau;
  await avancar(500);
  assert.equal(ctl.fonte.tau, tauPausado, 'pausado não avança');
  ctl.continuar();
  for (let i = 0; i < 100 && fim === null; i++) await avancar(100);
  assert.equal(fim, true);
  await avancar(500);
  assert.deepEqual(tr.fw.pos, grausParaPassos(config, [60, 60, -40, 0]));
  verificarSegmentos(config, segs);
});

test('emergência põe o firmware em alarme e ressincroniza após destravar', async () => {
  const { ctl, tr, app, config, avancar } = await montar();
  ctl.moverJunta([90, 60, -60, 0]).catch(() => {});
  await avancar(800);
  ctl.emergencia();
  await avancar(100);
  assert.equal(tr.fw.estado, 'ALARME');
  const pos = [...tr.fw.pos];
  await avancar(500);
  assert.deepEqual(tr.fw.pos, pos, 'parado após a emergência');
  await op.destravar(app);
  assert.equal(tr.fw.estado, 'OCIOSO');
  assert.deepEqual(grausParaPassos(config, ctl.qCmd), pos);
});

test('homing simulado leva a junta à posição da chave', async () => {
  const { app, tr, config, avancar } = await montar();
  config.juntas[3].fimDeCurso.usar = true;
  let ok = false;
  op.homing(app).then(() => (ok = true));
  for (let i = 0; i < 400 && !ok; i++) await avancar(50);
  assert.ok(ok);
  assert.equal(tr.fw.pos[3], grausParaPassos(config, [0, 0, 0, config.juntas[3].fimDeCurso.angulo])[3]);
});
