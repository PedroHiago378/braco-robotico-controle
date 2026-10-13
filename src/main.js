// Ponto de entrada: monta o estado do app, os módulos de controle e a interface.

import './estilo.css';
import { normalizarConfig, validarConfig } from './nucleo/config.js';
import { Cinematica } from './nucleo/cinematica.js';
import { Timeline } from './nucleo/timeline.js';
import { Controlador } from './nucleo/controlador.js';
import { SUAVE5_VMAX, SUAVE5_AMAX } from './nucleo/perfis.js';
import * as op from './nucleo/operacoes.js';
import { Emissor, clamp, quaseIgual } from './nucleo/util.js';
import { LinkRobo } from './hardware/link.js';
import { TransporteSimulado } from './hardware/simulador.js';
import { TransporteSerial } from './hardware/serial.js';
import { criarRelogio } from './hardware/relogio.js';
import { Visualizador3D } from './ui/visualizador3d.js';
import { h, fmt, toast, baixarArquivo, abrirArquivo, interruptor } from './ui/dom.js';
import { criarPainelControle } from './ui/painel-controle.js';
import { criarPainelConexao } from './ui/painel-conexao.js';
import { criarPainelConfig } from './ui/painel-config.js';
import { criarEditorTimeline } from './ui/editor-timeline.js';
import demo from '../exemplos/demo-pega-e-solta.json';

// ---- persistência local ---------------------------------------------------------------
const CHAVES = { config: 'braco.config.v1', timeline: 'braco.timeline.v1', opcoes: 'braco.opcoes.v1' };
const ler = (k) => {
  try {
    const s = localStorage.getItem(k);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};
const gravar = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* armazenamento indisponível */
  }
};
const debounce = (fn, ms) => {
  let id;
  return (...a) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...a), ms);
  };
};

// ---- estado ---------------------------------------------------------------------------
let config = normalizarConfig(ler(CHAVES.config) ?? undefined);
if (validarConfig(config).erros.length) config = normalizarConfig();

const cin = new Cinematica(config.geometria);
const link = new LinkRobo();
const ctl = new Controlador({ config, cin, link });
const tl = new Timeline();
try {
  tl.carregarJSON(ler(CHAVES.timeline) ?? demo);
} catch {
  tl.carregarJSON(demo);
}

const opcoes = {
  seguirAoVivo: true,
  modoSeguir: 'junta',
  phiLivre: true,
  ramoCotovelo: 'auto',
  ramoBase: 'auto',
  passoJunta: 5,
  passoMm: 10,
  fator: 1,
  loop: false,
  logSegmentos: false,
  logStatus: false,
  ...ler(CHAVES.opcoes),
};
opcoes.mostrar = { cad: true, fantasma: true, trilha: true, caminho: true, alcance: false, gizmo: true, ...opcoes.mostrar };
ctl.definirFatorVelocidade(opcoes.fator);

const app = new Emissor();
Object.defineProperty(app, 'config', { get: () => config }); // substituída em aplicarConfig
Object.assign(app, {
  cin,
  link,
  ctl,
  timeline: tl,
  opcoes,
  ctx: { cin, juntas: config.juntas },
  alvo: { q: [...config.poseInicial], valido: true, avisoIK: null, phiDesejado: 0 },
  real: { q: null, status: null },
  playhead: 0,
  selecao: null,
  preview: { tocando: false },
  executando: false,
  validacao: null,
  conexao: { tipo: 'simulador', nome: '' },
  geometriaCAD: null,
});
app.alvo.phiDesejado = cin.pose(app.alvo.q).phi;

app.notificar = (msg, tipo = 'info') => {
  toast(msg, tipo);
  app.emit('log', msg);
};
app.salvarOpcoes = debounce(() => gravar(CHAVES.opcoes, opcoes), 300);

// ---- alvo -----------------------------------------------------------------------------
app.definirAlvo = (q, { seguir = true, origem, manterPhi = false } = {}) => {
  const J = config.juntas;
  app.alvo.q = q.map((v, i) => clamp(v, J[i].min, J[i].max));
  app.alvo.valido = true;
  if (origem !== 'pose') app.alvo.avisoIK = null;
  if (!manterPhi) app.alvo.phiDesejado = cin.pose(app.alvo.q).phi;
  app.emit('alvo', origem);
  if (seguir) app.seguirAlvoAgora();
};

app.seguirAlvoAgora = () => {
  if (!opcoes.seguirAoVivo || !link.pronto || ctl.ocupado || app.preview.tocando || app.executando) return;
  if (opcoes.modoSeguir === 'cartesiano') ctl.seguirPose(cin.pose(app.alvo.q));
  else ctl.seguir(app.alvo.q);
};

app.definirAlvoJunta = (i, v) => {
  const q = [...app.alvo.q];
  q[i] = v;
  app.definirAlvo(q, { origem: 'junta' });
};

app.definirAlvoPose = (pose, { origem = 'pose', manterPhi = false } = {}) => {
  if (!manterPhi) app.alvo.phiDesejado = pose.phi;
  const sol = cin.resolver(pose, app.alvo.q, config.juntas, {
    phiLivre: opcoes.phiLivre,
    ramoCotovelo: opcoes.ramoCotovelo,
    ramoBase: opcoes.ramoBase,
  });
  if (!sol) {
    app.alvo.valido = false;
    app.alvo.avisoIK = 'Alvo fora do alcance ou dos limites das juntas';
    app.emit('alvo', origem);
    return false;
  }
  app.alvo.avisoIK = sol.exato ? null : `φ ajustado para ${fmt(sol.phi)}° (o pedido é inalcançável)`;
  app.definirAlvo(sol.q, { origem: 'pose', manterPhi: true });
  return true;
};

app.jogCartesiano = (eixo, delta) => {
  const p = cin.pose(app.alvo.q);
  p.phi = app.alvo.phiDesejado;
  p[eixo] += delta;
  app.definirAlvoPose(p, { origem: 'jog' });
};

// ---- movimentos -----------------------------------------------------------------------
const ignorarCancelamento = (e) => {
  if (!/Substituído|Cancelado|Homing|Referência|emergência|Configuração|Desconectado/.test(e.message))
    app.notificar(e.message, 'erro');
};

app.moverRobo = (q, tipo = 'junta') => {
  if (!link.pronto) return app.notificar('Conecte ao robô ou ao simulador primeiro', 'erro');
  if (app.executando) return app.notificar('Há um programa em execução', 'aviso');
  const p = tipo === 'linear' ? ctl.moverLinear(cin.pose(q)) : ctl.moverJunta(q);
  p.catch(ignorarCancelamento);
};

app.emergencia = () => {
  app.preview.tocando = false;
  if (link.pronto) ctl.emergencia();
  app.notificar('PARADA DE EMERGÊNCIA — use "Destravar alarme" na aba Conexão', 'erro');
};

// ---- conexão --------------------------------------------------------------------------
app.conectar = async (tipo = 'simulador', baud = config.serial.baud) => {
  if (tipo === 'serial' && !TransporteSerial.suportado())
    return app.notificar('Este navegador não tem Web Serial. Use Chrome ou Edge.', 'erro');
  const tr = tipo === 'serial' ? new TransporteSerial(baud) : new TransporteSimulado();
  try {
    const r = await op.conectar(app, tr);
    app.conexao = { tipo, nome: tr.nome };
    if (tipo === 'simulador') await op.ligarMotores(app, true);
    app.real.q = [...ctl.qCmd];
    app.definirAlvo(ctl.qCmd, { seguir: false });
    app.notificar(`Conectado: ${tr.nome}`, 'ok');
    if (r.assumida && tipo === 'serial')
      app.notificar('Referência assumida: o braço deve estar fisicamente na pose inicial.', 'aviso');
  } catch (e) {
    if (e.name !== 'NotFoundError') app.notificar(`Falha ao conectar: ${e.message}`, 'erro');
  }
};

app.desconectar = async () => {
  ctl.cancelar('Desconectado');
  await link.desconectar();
  app.real.q = null;
};

app.motores = (ligar) => op.ligarMotores(app, ligar);

app.homing = async () => {
  await op.homing(app, (m) => app.emit('log', m));
  app.definirAlvo(ctl.qCmd, { seguir: false });
};

app.referenciar = async (q) => {
  await op.referenciar(app, q);
  app.definirAlvo(q, { seguir: false });
};

app.destravar = async () => {
  await op.destravar(app);
  app.definirAlvo(ctl.qCmd, { seguir: false });
};

ctl.on('real', (q, s) => {
  app.real.q = q;
  app.real.status = s;
});
ctl.on('aviso', (m) => app.notificar(m, 'aviso'));
link.on('alarme', (a) => app.notificar(`ALARME: ${a.texto}`, 'erro'));
link.on('reinicio', () => app.notificar('O firmware reiniciou: a referência foi perdida. Reconecte.', 'erro'));
link.on('estado', (e) => {
  if (e === 'desconectado') app.real.q = null;
});

// ---- configuração ---------------------------------------------------------------------
const mapaPassos = (c) => JSON.stringify(c.juntas.map((j) => [j.passosVolta, j.micropassos, j.reducao, j.inverter]));

app.aplicarConfig = async (nova) => {
  const { erros, avisos } = validarConfig(nova, link.info?.tick ?? 20000);
  if (erros.length) return { erros, avisos };
  if (ctl.ocupado || app.executando) return { erros: ['Pare o movimento antes de aplicar a configuração.'], avisos };
  const mudouPassos = mapaPassos(config) !== mapaPassos(nova);
  if (link.pronto) {
    await ctl.pararEsperar();
    await link.comando('W');
  }
  const qAtual = [...ctl.qCmd];
  config = nova;
  ctl.definirConfig(nova);
  cin.definirGeometria(nova.geometria);
  app.ctx.juntas = nova.juntas;
  gravar(CHAVES.config, nova);
  if (link.pronto) {
    await op.enviarParametros(app);
    if (mudouPassos) await op.referenciar(app, qAtual.map((v, i) => clamp(v, nova.juntas[i].min, nova.juntas[i].max)));
  }
  viewer.reconstruir(nova.geometria);
  app.definirAlvo(app.alvo.q, { seguir: false });
  app.emit('config');
  conferirGeometriaCAD();
  validarTimeline();
  atualizarAlcance();
  return { erros: [], avisos };
};

// ---- timeline -------------------------------------------------------------------------
app.definirPlayhead = (t, { mostrar = true } = {}) => {
  app.playhead = Math.max(0, t);
  if (mostrar && !app.executando && tl.keyframes.length)
    app.definirAlvo(tl.amostrar(app.playhead, app.ctx), { seguir: false, origem: 'timeline' });
};

app.selecionarKF = (id, { mover = true } = {}) => {
  app.selecao = id;
  const kf = tl.porId(id);
  if (kf && mover && !app.executando) {
    app.preview.tocando = false;
    app.definirPlayhead(kf.t);
  }
  app.emit('selecao');
};

app.irParaKF = (id) => {
  const kf = tl.porId(id);
  if (!kf) return;
  app.selecionarKF(id);
  app.definirAlvo(kf.q);
};

app.pularKF = (dir) => {
  const K = tl.keyframes;
  if (!K.length) return;
  const k =
    dir > 0 ? K.find((x) => x.t > app.playhead + 1e-6) ?? K[K.length - 1] : [...K].reverse().find((x) => x.t < app.playhead - 1e-6) ?? K[0];
  app.selecionarKF(k.id);
};

/** Duração mínima de um segmento "suave" entre duas poses, pelos limites das juntas. */
function duracaoSuave(qa, qb) {
  let T = 0;
  config.juntas.forEach((j, i) => {
    const d = Math.abs(qb[i] - qa[i]);
    T = Math.max(T, (SUAVE5_VMAX * d) / j.velMax, Math.sqrt((SUAVE5_AMAX * d) / j.accMax));
  });
  return Math.max(0.5, Math.ceil(T * 1.1 * 4) / 4);
}

app.adicionarKFNoFim = () => {
  const K = tl.keyframes;
  let t = 0;
  if (K.length) {
    const ult = K[K.length - 1];
    if (quaseIgual(ult.q, app.alvo.q, 0.01)) return app.notificar('O alvo é igual ao último keyframe', 'aviso');
    t = ult.t + duracaoSuave(ult.q, app.alvo.q);
  }
  const kf = tl.adicionar(t, app.alvo.q, 'suave');
  app.selecionarKF(kf.id, { mover: false });
  app.playhead = kf.t;
};

app.adicionarKF = () => {
  const K = tl.keyframes;
  const noFim = K.length && Math.abs(app.playhead - tl.duracao) < 1e-3;
  if (noFim && !quaseIgual(K[K.length - 1].q, app.alvo.q, 0.01)) return app.adicionarKFNoFim();
  const interp = K.length ? K[tl.indiceSegmento(app.playhead)].interp : 'suave';
  const kf = tl.adicionar(app.playhead, app.alvo.q, interp);
  app.selecionarKF(kf.id, { mover: false });
};

app.removerKF = (id) => {
  tl.remover(id);
  if (app.selecao === id) app.selecionarKF(null);
};

app.timelineMudou = () => tl.emit('mudou');

function validarTimeline(avisar = false) {
  app.validacao = tl.validar(app.ctx, config);
  atualizarCaminho();
  app.emit('validacao');
  if (avisar)
    app.notificar(
      app.validacao.ok ? 'Timeline dentro dos limites' : `${app.validacao.problemas.length} problema(s) na timeline`,
      app.validacao.ok ? 'ok' : 'aviso',
    );
  return app.validacao;
}
app.validarTimeline = validarTimeline;

app.corrigirTempos = () => {
  const r = tl.corrigirTempos(app.ctx, config);
  validarTimeline();
  if (r.ok) app.notificar(`Tempos ajustados (${r.iteracoes} passada(s)). Duração: ${fmt(tl.duracao, 2)} s`, 'ok');
  else
    app.notificar(
      `Restam ${r.restantes.length} problema(s) que esticar o tempo não resolve (limite, alcance, torque ou interpolação linear).`,
      'aviso',
    );
};

app.alternarPrevia = () => {
  if (app.executando || tl.keyframes.length < 2) return;
  app.preview.tocando = !app.preview.tocando;
  if (app.preview.tocando && app.playhead >= tl.duracao - 1e-6) app.playhead = tl.keyframes[0].t;
};

app.executar = async () => {
  if (!link.pronto) return app.notificar('Conecte ao robô ou ao simulador primeiro', 'erro');
  if (tl.keyframes.length < 2) return app.notificar('A timeline precisa de ao menos 2 keyframes', 'aviso');
  const v = validarTimeline();
  if (
    !v.ok &&
    !confirm(
      `A timeline tem ${v.problemas.length} problema(s):\n\n${v.problemas
        .slice(0, 8)
        .map((p) => '• ' + p.msg)
        .join('\n')}\n\nA trava de segurança vai limitar as velocidades (o caminho pode se deformar). Executar mesmo assim?`,
    )
  )
    return;
  app.preview.tocando = false;
  const inicio = app.playhead >= tl.duracao - 1e-6 ? 0 : app.playhead;
  app.executando = true;
  app.emit('execucao');
  try {
    const completo = await ctl.executarTimeline(tl, app.ctx, { loop: opcoes.loop, inicio });
    app.notificar(completo ? 'Programa concluído' : 'Programa parado', completo ? 'ok' : 'info');
  } catch (e) {
    ignorarCancelamento(e);
  } finally {
    app.executando = false;
    app.definirAlvo(ctl.qCmd, { seguir: false });
    app.emit('execucao');
  }
};

app.pausarExecucao = () => (ctl.pausado ? ctl.continuar() : ctl.pausar());
app.pararExecucao = () => ctl.pararSuave();

app.novaTimeline = () => {
  if (tl.keyframes.length && !confirm('Descartar a timeline atual?')) return;
  tl.nome = 'Programa';
  tl.limpar();
  app.playhead = 0;
  app.selecionarKF(null);
};

app.abrirTimeline = async () => {
  try {
    tl.carregarJSON(JSON.parse(await abrirArquivo('.json')));
    app.playhead = 0;
    app.selecionarKF(null);
    editor.enquadrar();
    app.notificar(`Timeline "${tl.nome}" carregada`, 'ok');
  } catch (e) {
    if (e.message !== 'Nenhum arquivo') app.notificar(`Falha ao abrir: ${e.message}`, 'erro');
  }
};

app.salvarTimeline = () =>
  baixarArquivo(`${(tl.nome || 'programa').replace(/[^\w-]+/g, '_')}.timeline.json`, JSON.stringify(tl.paraJSON(), null, 2));

const salvarTimelineLocal = debounce(() => gravar(CHAVES.timeline, tl.paraJSON()), 400);
const validarDepois = debounce(() => validarTimeline(), 120);
tl.on('mudou', () => {
  salvarTimelineLocal();
  validarDepois();
});

// ---- interface ------------------------------------------------------------------------
const indicador = h('span', { class: 'indicador' });
const estadoTxt = h('span', {});
const velocidade = h('input', { type: 'range', min: 5, max: 100, step: 5, value: Math.round(opcoes.fator * 100) });
const velTxt = h('span', { class: 'mono' }, `${Math.round(opcoes.fator * 100)}%`);
velocidade.addEventListener('input', () => {
  opcoes.fator = Number(velocidade.value) / 100;
  ctl.definirFatorVelocidade(opcoes.fator);
  velTxt.textContent = `${velocidade.value}%`;
  app.salvarOpcoes();
});
const topo = h(
  'header',
  { class: 'topo' },
  h('div', { class: 'marca' }, h('strong', {}, 'Controle do Braço RRRR'), h('small', {}, '4 × Nema 17')),
  h('div', { class: 'conexao' }, indicador, estadoTxt),
  h('label', { class: 'vel', title: 'Escala velocidade e aceleração de todos os movimentos' }, 'Velocidade', velocidade, velTxt),
  h('button', { class: 'emergencia', title: 'Parada de emergência (Esc)', onclick: () => app.emergencia() }, 'EMERGÊNCIA'),
);

const vistaEl = h('div', { class: 'vista3d' });
const viewer = new Visualizador3D(vistaEl, config.geometria);
const painelControle = criarPainelControle(app);
const painelConexao = criarPainelConexao(app);
const painelConfig = criarPainelConfig(app);
const editor = criarEditorTimeline(app);

const abas = [
  ['controle', 'Controle', painelControle.el],
  ['conexao', 'Conexão', painelConexao.el],
  ['config', 'Configuração', painelConfig.el],
];
const cabecalhoAbas = h('nav', { class: 'abas' });
const corpoAbas = h('div', { class: 'corpo-abas' });
function abrirAba(id) {
  cabecalhoAbas.replaceChildren(
    ...abas.map(([k, nome]) => h('button', { class: k === id ? 'ativa' : '', onclick: () => abrirAba(k) }, nome)),
  );
  corpoAbas.replaceChildren(abas.find(([k]) => k === id)[2]);
  opcoes.aba = id;
  app.salvarOpcoes();
}
abrirAba(opcoes.aba ?? 'controle');

const hud = h('div', { class: 'hud mono' });
const toggles = Object.entries({ cad: 'CAD', fantasma: 'Fantasma', trilha: 'Trilha', caminho: 'Caminho', alcance: 'Alcance', gizmo: 'Gizmo' }).map(
  ([k, nome]) =>
    interruptor(nome, opcoes.mostrar[k], (v) => {
      opcoes.mostrar[k] = v;
      app.salvarOpcoes();
      aplicarVisibilidade();
    }).el,
);
const ferramentas = h(
  'div',
  { class: 'ferramentas3d' },
  h(
    'div',
    { class: 'grupo' },
    Object.entries({ iso: 'Iso', topo: 'Topo', frente: 'Frente', lado: 'Lado' }).map(([k, n]) =>
      h('button', { class: 'mini', onclick: () => viewer.vista(k) }, n),
    ),
  ),
  h('div', { class: 'grupo' }, toggles, h('button', { class: 'mini', onclick: () => viewer.limparTrilha() }, 'limpar trilha')),
);
vistaEl.append(hud, ferramentas);

document.getElementById('app').append(
  topo,
  h('div', { class: 'meio' }, h('aside', { class: 'lateral' }, cabecalhoAbas, corpoAbas), vistaEl),
  editor.el,
);

function aplicarVisibilidade() {
  const m = opcoes.mostrar;
  viewer.usarCAD(m.cad);
  viewer.trilha.visible = m.trilha;
  viewer.mostrarCaminho(m.caminho);
  viewer.grupoAlcance.visible = m.alcance;
  viewer.gizmoAtivo(m.gizmo);
  if (m.alcance) atualizarAlcance();
}

let phiAlcance = null;
function atualizarAlcance(forcar = true) {
  if (!opcoes.mostrar.alcance) return;
  const phi = Math.round(cin.pose(app.alvo.q).phi);
  if (!forcar && phi === phiAlcance) return;
  phiAlcance = phi;
  viewer.definirAlcance(cin.fatiaAlcance(config.juntas, phi, 2));
}
app.on('alvo', debounce(() => atualizarAlcance(false), 150));

function atualizarCaminho() {
  const pontas = app.validacao?.pontas ?? [];
  viewer.definirCaminho(
    pontas,
    tl.keyframes.map((k) => ({ id: k.id, p: cin.direta(k.q).ponta })),
    app.selecao,
  );
}
app.on('selecao', atualizarCaminho);

// gizmo 3D
viewer.on('arrasteAlvo', (pos) => {
  if (app.executando) return;
  app.preview.tocando = false;
  app.definirAlvoPose({ x: pos.x, y: pos.y, z: pos.z, phi: app.alvo.phiDesejado }, { origem: 'gizmo', manterPhi: true });
});
viewer.on('arrasteFim', () => {
  if (!app.alvo.valido) {
    app.alvo.valido = true;
    app.alvo.avisoIK = 'Ponto inalcançável: mantido o último alvo válido';
  }
});
viewer.on('cliqueKF', (id) => app.selecionarKF(id));

// atalhos
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    app.emergencia();
    return;
  }
  if (e.target.matches?.('input, select, textarea')) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (app.executando) app.pausarExecucao();
      else app.alternarPrevia();
      break;
    case 'k':
    case 'K':
      if (e.shiftKey) app.adicionarKFNoFim();
      else app.adicionarKF();
      break;
    case 'Delete':
      if (app.selecao) app.removerKF(app.selecao);
      break;
    case 'ArrowLeft':
      app.pularKF(-1);
      break;
    case 'ArrowRight':
      app.pularKF(1);
      break;
    case 'Home':
      app.definirPlayhead(0);
      break;
    case 'End':
      app.definirPlayhead(tl.duracao);
      break;
    default:
  }
});

// ---- laço de quadros ------------------------------------------------------------------
let tAnterior = performance.now();
let qVis = [...config.poseInicial];
let ultimoUI = 0;

function atualizarUI() {
  const e = link.estado;
  const s = link.status;
  indicador.className = `indicador ${e === 'pronto' ? (s?.alarme ? 'erro' : 'ok') : e === 'conectando' ? 'aviso' : ''}`;
  estadoTxt.textContent =
    e === 'pronto'
      ? `${app.conexao.tipo === 'simulador' ? 'Simulador' : 'Serial'} · ${s?.alarme ? 'ALARME' : (s?.estado ?? '…').toLowerCase()} · ${ctl.modo}${app.executando ? ' (programa)' : ''}`
      : e === 'conectando'
        ? 'Conectando…'
        : 'Desconectado';
  const pa = cin.pose(app.alvo.q);
  const linhas = [`alvo  X ${fmt(pa.x)}  Y ${fmt(pa.y)}  Z ${fmt(pa.z)}  φ ${fmt(pa.phi)}°`];
  if (app.real.q) {
    const pr = cin.pose(app.real.q);
    const erro = Math.hypot(pr.x - pa.x, pr.y - pa.y, pr.z - pa.z);
    linhas.push(`real  X ${fmt(pr.x)}  Y ${fmt(pr.y)}  Z ${fmt(pr.z)}  φ ${fmt(pr.phi)}°   Δ ${fmt(erro)} mm`);
  }
  if (!app.alvo.valido || app.alvo.avisoIK) linhas.push(`⚠ ${app.alvo.avisoIK}`);
  hud.textContent = linhas.join('\n');
  painelControle.atualizar();
  painelConexao.atualizar();
}

function quadro(agora) {
  passoQuadro(agora);
  requestAnimationFrame(quadro);
}

function passoQuadro(agora) {
  const dt = Math.min(0.1, (agora - tAnterior) / 1000);
  tAnterior = agora;

  if (app.preview.tocando) {
    let t = app.playhead + dt * opcoes.fator;
    if (t >= tl.duracao) {
      if (opcoes.loop) t = tl.keyframes[0]?.t ?? 0;
      else {
        t = tl.duracao;
        app.preview.tocando = false;
      }
    }
    app.definirPlayhead(t);
  } else if (app.executando) {
    const tau = ctl.tauExecutando();
    if (tau !== null) {
      app.playhead = tau;
      app.alvo.q = tl.amostrar(tau, app.ctx);
    }
  }

  if (app.real.q) {
    const k = Math.min(1, dt / 0.05);
    qVis = qVis.map((v, i) => v + (app.real.q[i] - v) * k);
  }
  viewer.definirPoses(qVis, app.alvo.q);
  viewer.real.destacarLimites(qVis, config.juntas);
  // fantasma só quando difere do real (sobreposto, só polui o desenho)
  viewer.alvo.visivel(opcoes.mostrar.fantasma && app.alvo.q.some((v, i) => Math.abs(v - qVis[i]) > 0.5));
  viewer.definirMarcador(cin.direta(app.alvo.q).ponta, app.alvo.valido);
  viewer.orientarAlcance(app.alvo.q[0]);
  if (opcoes.mostrar.trilha && app.real.q) viewer.adicionarTrilha(cin.direta(qVis).ponta);

  if (agora - ultimoUI > 100) {
    ultimoUI = agora;
    atualizarUI();
  }
  editor.atualizar();
}

// ---- modelo 3D do CAD (public/modelos/braco.glb, gerado do STEP) -------------------------
const CAMPOS_GEOMETRIA_CAD = ['alturaOmbro', 'offsetOmbro', 'L1', 'L2'];
function conferirGeometriaCAD() {
  const cad = app.geometriaCAD;
  if (!cad) return;
  const dif = CAMPOS_GEOMETRIA_CAD.filter((k) => Math.abs(config.geometria[k] - cad[k]) > 0.5);
  if (dif.length)
    app.notificar(
      `A geometria configurada difere do CAD em ${dif.join(', ')}: o desenho não vai bater com a cinemática. ` +
        'Use "Usar geometria do CAD" na aba Configuração.',
      'aviso',
    );
}

viewer
  .carregarCAD('./modelos/braco.glb')
  .then(({ geometria }) => {
    app.geometriaCAD = geometria;
    aplicarVisibilidade();
    app.emit('cad');
    conferirGeometriaCAD();
  })
  .catch((e) => app.notificar(`Modelo CAD não carregado (${e.message}); usando o modelo simplificado.`, 'aviso'));

aplicarVisibilidade();
validarTimeline();
criarRelogio(() => ctl.passo(), 5);
requestAnimationFrame(quadro);
app.conectar('simulador');

// acesso pelo console do navegador, para depuração
window.braco = app;
app.depurar = {
  viewer,
  /** Desenha um quadro sem depender do requestAnimationFrame (aba oculta). */
  renderizar() {
    passoQuadro(performance.now());
    viewer.renderer.render(viewer.cena, viewer.camera);
  },
};
