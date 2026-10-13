// Editor de timeline: barra de ferramentas, canvas (régua, keyframes, curvas das juntas,
// trechos com problema) e painel de propriedades do keyframe selecionado.

import { h, fmt, seletor, interruptor } from './dom.js';
import { INTERPOLACOES } from '../nucleo/timeline.js';
import { CORES_JUNTAS } from './painel-controle.js';

const ALT_REGUA = 22;
const ALT_TRILHA = 30;
const MARGEM = 12;
const PASSOS_GRADE = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];

export function criarEditorTimeline(app) {
  const tl = app.timeline;
  const vista = { px: 90, inicio: -0.3 };
  let sujo = true;
  let arraste = null;
  let ultimoPlayhead = -1;

  // ---- barra de ferramentas
  const btnPrevia = h('button', { title: 'Anima o fantasma sem mover o robô (Espaço)', onclick: () => app.alternarPrevia() }, '▶ Prévia');
  const btnExec = h('button', { class: 'primario', title: 'Executa no robô a partir do cursor', onclick: () => app.executar() }, '▶ Executar no robô');
  const btnPausar = h('button', { onclick: () => app.pausarExecucao() }, '⏸ Pausar');
  const btnParar = h('button', { class: 'aviso', onclick: () => app.pararExecucao() }, '⏹ Parar');
  const loop = interruptor('Loop', app.opcoes.loop, (v) => {
    app.opcoes.loop = v;
    app.salvarOpcoes();
  });
  const tempo = h('span', { class: 'tempo' });
  const barra = h(
    'div',
    { class: 'tl-barra' },
    h('button', { class: 'mini', title: 'Início (Home)', onclick: () => app.definirPlayhead(0) }, '⏮'),
    h('button', { class: 'mini', title: 'Keyframe anterior (←)', onclick: () => app.pularKF(-1) }, '◀'),
    h('button', { class: 'mini', title: 'Próximo keyframe (→)', onclick: () => app.pularKF(1) }, '▶'),
    h('button', { class: 'mini', title: 'Fim (End)', onclick: () => app.definirPlayhead(tl.duracao) }, '⏭'),
    tempo,
    h('span', { class: 'sep' }),
    btnPrevia,
    btnExec,
    btnPausar,
    btnParar,
    loop.el,
    h('span', { class: 'sep' }),
    h('button', { title: 'Adiciona (ou atualiza) um keyframe no cursor com a pose do alvo (K)', onclick: () => app.adicionarKF() }, '+ Keyframe'),
    h('button', { title: 'Adiciona no fim, com tempo calculado pelos limites das juntas (Shift+K)', onclick: () => app.adicionarKFNoFim() }, '+ No fim'),
    h('button', { title: 'Estica os trechos que passam dos limites de velocidade/aceleração', onclick: () => app.corrigirTempos() }, 'Ajustar tempos'),
    h('span', { class: 'sep' }),
    h('button', { onclick: () => app.novaTimeline() }, 'Novo'),
    h('button', { onclick: () => app.abrirTimeline() }, 'Abrir'),
    h('button', { onclick: () => app.salvarTimeline() }, 'Salvar'),
    h('button', { class: 'mini', title: 'Enquadrar a timeline', onclick: () => enquadrar() }, '⤢'),
  );

  // ---- canvas
  const canvas = h('canvas', { class: 'tl-canvas' });
  const ctx2d = canvas.getContext('2d');
  const areaCanvas = h('div', { class: 'tl-area' }, canvas);
  new ResizeObserver(() => (sujo = true)).observe(areaCanvas);

  const props = h('div', { class: 'tl-props' });
  const el = h('div', { class: 'timeline' }, barra, h('div', { class: 'tl-corpo' }, areaCanvas, props));

  const X = (t) => MARGEM + (t - vista.inicio) * vista.px;
  const T = (x) => vista.inicio + (x - MARGEM) / vista.px;

  function enquadrar() {
    const d = Math.max(tl.duracao, 2);
    const w = canvas.clientWidth || 600;
    vista.px = Math.max(10, (w - 2 * MARGEM - 30) / (d + 0.6));
    vista.inicio = -0.3;
    sujo = true;
  }

  function acharKF(x, y) {
    if (y < ALT_REGUA - 4 || y > ALT_REGUA + ALT_TRILHA + 4) return null;
    let melhor = null;
    for (const k of tl.keyframes) {
      const d = Math.abs(X(k.t) - x);
      if (d <= 8 && (!melhor || d < melhor.d)) melhor = { d, k };
    }
    return melhor?.k ?? null;
  }

  const posicao = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = posicao(e);
    canvas.setPointerCapture(e.pointerId);
    const kf = acharKF(x, y);
    if (kf) {
      app.selecionarKF(kf.id);
      if (!app.executando) arraste = { tipo: 'kf', id: kf.id, dx: x - X(kf.t) };
    } else if (!app.executando) {
      arraste = { tipo: 'cursor' };
      app.definirPlayhead(Math.max(0, T(x)));
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const { x, y } = posicao(e);
    if (!arraste) {
      canvas.style.cursor = acharKF(x, y) ? 'grab' : 'default';
      return;
    }
    if (arraste.tipo === 'kf') {
      let t = T(x - arraste.dx);
      if (!e.altKey) t = Math.round(t / 0.05) * 0.05;
      const kf = tl.atualizar(arraste.id, { t: Math.max(0, t) });
      if (kf) app.definirPlayhead(kf.t);
    } else {
      app.definirPlayhead(Math.max(0, T(x)));
    }
  });
  const soltar = () => (arraste = null);
  canvas.addEventListener('pointerup', soltar);
  canvas.addEventListener('pointercancel', soltar);
  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = posicao(e);
    const kf = acharKF(x, y);
    if (kf) app.irParaKF(kf.id);
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { x } = posicao(e);
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        vista.inicio += (e.shiftKey ? e.deltaY : e.deltaX) / vista.px;
      } else {
        const t = T(x);
        vista.px = Math.min(1500, Math.max(8, vista.px * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        vista.inicio = t - (x - MARGEM) / vista.px;
      }
      sujo = true;
    },
    { passive: false },
  );

  // ---- desenho
  function desenhar() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hh = canvas.clientHeight;
    if (!w || !hh) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
    }
    const c = ctx2d;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hh);
    const yC = ALT_REGUA + ALT_TRILHA;
    const hC = hh - yC - 6;
    const dur = tl.duracao;

    c.fillStyle = '#171b21';
    c.fillRect(0, 0, w, hh);
    c.fillStyle = '#1d222a';
    c.fillRect(0, 0, w, ALT_REGUA);
    c.fillStyle = '#1a1f26';
    c.fillRect(0, ALT_REGUA, w, ALT_TRILHA);
    // região além do fim
    if (X(dur) < w) {
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(Math.max(0, X(dur)), ALT_REGUA, w, hh);
    }

    // grade
    const passo = PASSOS_GRADE.find((p) => p * vista.px >= 64) ?? 300;
    c.font = '11px system-ui, sans-serif';
    c.textBaseline = 'middle';
    for (let t = Math.floor(T(0) / passo) * passo; X(t) < w; t += passo) {
      const x = Math.round(X(t)) + 0.5;
      if (x < 0) continue;
      c.strokeStyle = '#2a313b';
      c.beginPath();
      c.moveTo(x, ALT_REGUA - 6);
      c.lineTo(x, hh);
      c.stroke();
      c.fillStyle = '#8b95a5';
      c.fillText(`${+t.toFixed(2)}s`, x + 3, ALT_REGUA / 2);
    }

    // trechos com problema
    for (const p of app.validacao?.problemas ?? []) {
      const x0 = X(p.t0);
      const x1 = X(p.t1);
      c.fillStyle = p.tipo === 'torque' ? 'rgba(255,167,38,0.16)' : 'rgba(255,82,82,0.16)';
      c.fillRect(x0, yC, x1 - x0, hC);
      c.fillStyle = p.tipo === 'torque' ? '#ffa726' : '#ff5252';
      c.fillRect(x0, ALT_REGUA + ALT_TRILHA - 4, x1 - x0, 3);
    }

    // curvas das juntas (normalizadas pelos limites)
    const K = tl.keyframes;
    if (K.length) {
      const xa = Math.max(0, X(K[0].t));
      const xb = Math.min(w, X(dur));
      const juntas = app.config.juntas;
      const ys = juntas.map(() => []);
      for (let x = xa; x <= xb + 1; x += 2) {
        const q = tl.amostrar(Math.min(T(Math.min(x, xb)), dur), app.ctx);
        q.forEach((v, j) => ys[j].push([x, yC + hC * (1 - (v - juntas[j].min) / (juntas[j].max - juntas[j].min))]));
      }
      c.lineWidth = 1.6;
      ys.forEach((pts, j) => {
        c.strokeStyle = CORES_JUNTAS[j];
        c.beginPath();
        pts.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.stroke();
      });
      c.lineWidth = 1;
    }
    // legenda
    c.textBaseline = 'top';
    let lx = 8;
    app.config.juntas.forEach((j, i) => {
      c.fillStyle = CORES_JUNTAS[i];
      c.fillRect(lx, yC + 6, 10, 3);
      c.fillStyle = '#aab3c0';
      c.fillText(j.nome, lx + 14, yC + 2);
      lx += c.measureText(j.nome).width + 30;
    });

    // keyframes
    c.textBaseline = 'middle';
    const yK = ALT_REGUA + ALT_TRILHA / 2;
    for (const k of K) {
      const x = X(k.t);
      if (x < -10 || x > w + 10) continue;
      const sel = k.id === app.selecao;
      c.strokeStyle = sel ? 'rgba(255,213,79,0.5)' : 'rgba(179,136,255,0.25)';
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(x, yC);
      c.lineTo(x, hh);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = sel ? '#ffd54f' : k.interp === 'cartesiana' ? '#4dd0e1' : k.interp === 'linear' ? '#90a4ae' : '#b388ff';
      const r = sel ? 8 : 6.5;
      c.beginPath();
      c.moveTo(x, yK - r);
      c.lineTo(x + r, yK);
      c.lineTo(x, yK + r);
      c.lineTo(x - r, yK);
      c.closePath();
      c.fill();
      if (sel || vista.px > 40) {
        c.fillStyle = sel ? '#ffe082' : '#9aa3b2';
        c.fillText(k.nome, x + r + 3, yK);
      }
    }

    // cursor
    const xp = Math.round(X(app.playhead)) + 0.5;
    c.strokeStyle = app.executando ? '#ff7043' : '#ffb74d';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(xp, 0);
    c.lineTo(xp, hh);
    c.stroke();
    c.lineWidth = 1;
    c.fillStyle = c.strokeStyle;
    c.beginPath();
    c.moveTo(xp - 6, 0);
    c.lineTo(xp + 6, 0);
    c.lineTo(xp, 9);
    c.closePath();
    c.fill();
  }

  // ---- propriedades
  function renderProps() {
    const kf = tl.porId(app.selecao);
    if (!kf) {
      const nome = h('input', { type: 'text', value: tl.nome });
      nome.addEventListener('change', () => {
        tl.nome = nome.value;
        app.timelineMudou();
      });
      const v = app.validacao;
      const lista = (v?.problemas ?? []).slice(0, 30).map((p) =>
        h('div', { class: p.tipo === 'torque' ? 'aviso clicavel' : 'erro clicavel', onclick: () => app.selecionarKF(tl.keyframes[p.seg].id) }, p.msg),
      );
      props.replaceChildren(
        h('h4', {}, 'Programa'),
        h('label', { class: 'campo largo' }, h('span', {}, 'Nome'), nome),
        h('div', { class: 'info' }, `${tl.keyframes.length} keyframes · ${fmt(tl.duracao, 2)} s`),
        v && tl.keyframes.length > 1
          ? v.ok
            ? h('div', { class: 'ok' }, 'Dentro dos limites de velocidade, aceleração, alcance e torque.')
            : h('div', {}, h('div', { class: 'info' }, `${v.problemas.length} problema(s):`), lista)
          : h('div', { class: 'nota' }, 'Clique na trilha para posicionar o cursor. Componha a pose (sliders, gizmo 3D) e pressione K.'),
      );
      return;
    }
    const i = tl.keyframes.indexOf(kf);
    const nome = h('input', { type: 'text', value: kf.nome });
    nome.addEventListener('change', () => tl.atualizar(kf.id, { nome: nome.value }));
    const t = h('input', { type: 'number', step: 0.05, min: 0, value: kf.t });
    t.addEventListener('change', () => tl.atualizar(kf.id, { t: Number(t.value) }));
    const interp = seletor(INTERPOLACOES, kf.interp, (v) => tl.atualizar(kf.id, { interp: v }));
    const p = app.cin.pose(kf.q);
    const problemas = (app.validacao?.problemas ?? []).filter((x) => x.seg === i || x.seg === i - 1);
    props.replaceChildren(
      h('h4', {}, `Keyframe ${i + 1} de ${tl.keyframes.length}`),
      h('label', { class: 'campo largo' }, h('span', {}, 'Nome'), nome),
      h('label', { class: 'campo largo' }, h('span', {}, 'Tempo'), t, h('small', {}, 's')),
      h('label', { class: 'campo largo' }, h('span', {}, i < tl.keyframes.length - 1 ? 'Até o próximo' : 'Interpolação'), interp),
      h(
        'div',
        { class: 'info mono' },
        app.config.juntas.map((j, k) => `${j.nome[0]} ${fmt(kf.q[k])}°`).join('  '),
        h('br'),
        `X ${fmt(p.x)}  Y ${fmt(p.y)}  Z ${fmt(p.z)}  φ ${fmt(p.phi)}°`,
      ),
      h(
        'div',
        { class: 'botoes' },
        h('button', { title: 'Grava a pose atual do alvo neste keyframe', onclick: () => tl.atualizar(kf.id, { q: app.alvo.q }) }, 'Atualizar com alvo'),
        h('button', { title: 'Leva o alvo para este keyframe (duplo clique)', onclick: () => app.irParaKF(kf.id) }, 'Alvo = keyframe'),
        h('button', { onclick: () => app.moverRobo(kf.q, 'junta') }, 'Mover robô até aqui'),
        h('button', { class: 'aviso', onclick: () => app.removerKF(kf.id) }, 'Excluir'),
        h('button', { class: 'mini', onclick: () => app.selecionarKF(null) }, 'fechar'),
      ),
      problemas.map((x) => h('div', { class: x.tipo === 'torque' ? 'aviso' : 'erro' }, x.msg)),
    );
  }

  tl.on('mudou', () => {
    sujo = true;
    renderProps();
  });
  app.on('selecao', () => {
    sujo = true;
    renderProps();
  });
  app.on('validacao', () => {
    sujo = true;
    renderProps();
  });
  app.on('config', () => (sujo = true));
  renderProps();
  requestAnimationFrame(enquadrar);

  function atualizar() {
    const ex = app.executando;
    btnPrevia.textContent = app.preview.tocando ? '⏸ Prévia' : '▶ Prévia';
    btnPrevia.disabled = ex;
    btnExec.disabled = ex;
    btnPausar.disabled = !ex;
    btnParar.disabled = !ex;
    btnPausar.textContent = app.ctl.pausado ? '▶ Continuar' : '⏸ Pausar';
    tempo.textContent = `${fmt(app.playhead, 2)} / ${fmt(tl.duracao, 2)} s`;
    if (app.playhead !== ultimoPlayhead) {
      ultimoPlayhead = app.playhead;
      sujo = true;
      // mantém o cursor visível
      const w = canvas.clientWidth;
      const xp = X(app.playhead);
      if (w && (xp > w - 20 || xp < 0) && (app.preview.tocando || ex)) {
        vista.inicio = app.playhead - (w * 0.25) / vista.px;
      }
    }
    if (sujo) {
      sujo = false;
      desenhar();
    }
  }

  return { el, atualizar, enquadrar };
}
