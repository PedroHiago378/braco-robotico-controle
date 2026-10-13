// Painel de controle manual: juntas, posição cartesiana, modo de seguimento e ações.

import { h, fmt, seletor, interruptor } from './dom.js';
import { torquesEstaticos } from '../nucleo/torque.js';

export const CORES_JUNTAS = ['#4fc3f7', '#ffb74d', '#81c784', '#f06292'];

export function criarPainelControle(app) {
  const el = h('div', { class: 'painel' });
  let refs = null;

  function render() {
    el.replaceChildren();
    const o = app.opcoes;

    // ---- modo de seguimento
    const seguir = interruptor(
      'Seguir alvo ao vivo',
      o.seguirAoVivo,
      (v) => {
        o.seguirAoVivo = v;
        app.salvarOpcoes();
        if (v) app.seguirAlvoAgora();
        else if (app.ctl.modo === 'seguir') app.ctl.pararSuave();
      },
      'O robô persegue o alvo (fantasma) continuamente, respeitando velocidade e aceleração',
    );
    const modo = seletor({ junta: 'por juntas', cartesiano: 'cartesiano (ponta em reta)' }, o.modoSeguir, (v) => {
      o.modoSeguir = v;
      app.salvarOpcoes();
      if (app.ctl.modo === 'seguir') app.ctl.pararSuave();
    });
    el.append(h('section', {}, h('h3', {}, 'Modo'), h('div', { class: 'linha' }, seguir.el, modo)));

    // ---- juntas
    const passoJ = seletor({ 0.5: '0,5°', 1: '1°', 5: '5°', 10: '10°', 15: '15°' }, String(o.passoJunta), (v) => {
      o.passoJunta = Number(v);
      app.salvarOpcoes();
    });
    const linhas = app.config.juntas.map((j, i) => {
      const slider = h('input', { type: 'range', min: j.min, max: j.max, step: 0.1, value: app.alvo.q[i] });
      const num = h('input', { type: 'number', step: 0.1, min: j.min, max: j.max, value: app.alvo.q[i].toFixed(1) });
      const real = h('span', { class: 'real', title: 'Ângulo real (firmware)' }, '—');
      slider.addEventListener('input', () => app.definirAlvoJunta(i, Number(slider.value)));
      num.addEventListener('change', () => app.definirAlvoJunta(i, Number(num.value)));
      const jog = (s) => () => app.definirAlvoJunta(i, app.alvo.q[i] + s * app.opcoes.passoJunta);
      const linha = h(
        'div',
        { class: 'linha-junta' },
        h('span', { class: 'nome', style: { borderColor: CORES_JUNTAS[i] } }, j.nome),
        h('button', { class: 'mini', onclick: jog(-1), title: 'Diminuir' }, '−'),
        slider,
        h('button', { class: 'mini', onclick: jog(1), title: 'Aumentar' }, '+'),
        num,
        real,
      );
      return { linha, slider, num, real };
    });
    el.append(
      h(
        'section',
        {},
        h('h3', {}, 'Juntas ', h('small', {}, 'alvo / real (°)'), h('span', { class: 'dir' }, 'passo ', passoJ)),
        linhas.map((l) => l.linha),
      ),
    );

    // ---- cartesiano
    const passoC = seletor({ 1: '1 mm', 5: '5 mm', 10: '10 mm', 25: '25 mm', 50: '50 mm' }, String(o.passoMm), (v) => {
      o.passoMm = Number(v);
      app.salvarOpcoes();
    });
    const eixos = [
      ['x', 'X', 'mm'],
      ['y', 'Y', 'mm'],
      ['z', 'Z', 'mm'],
      ['phi', 'φ', '°'],
    ];
    const cart = {};
    const grade = h(
      'div',
      { class: 'grade-cart' },
      eixos.map(([k, rot, un]) => {
        const input = h('input', { type: 'number', step: k === 'phi' ? 1 : 0.5 });
        input.addEventListener('change', () => {
          const p = app.cin.pose(app.alvo.q);
          p.phi = app.alvo.phiDesejado;
          p[k] = Number(input.value);
          app.definirAlvoPose(p, { origem: 'cart' });
        });
        const passo = () => (k === 'phi' ? Math.max(1, app.opcoes.passoMm / 2) : app.opcoes.passoMm);
        cart[k] = input;
        return h(
          'div',
          { class: 'eixo' },
          h('span', {}, rot),
          h('button', { class: 'mini', onclick: () => app.jogCartesiano(k, -passo()) }, '−'),
          input,
          h('button', { class: 'mini', onclick: () => app.jogCartesiano(k, passo()) }, '+'),
          h('small', {}, un),
        );
      }),
    );
    const ramoC = seletor({ auto: 'cotovelo: auto', cima: 'cotovelo: cima', baixo: 'cotovelo: baixo' }, o.ramoCotovelo, (v) => {
      o.ramoCotovelo = v;
      app.salvarOpcoes();
    });
    const ramoB = seletor({ auto: 'base: auto', frente: 'base: frente', atras: 'base: atrás' }, o.ramoBase, (v) => {
      o.ramoBase = v;
      app.salvarOpcoes();
    });
    const phiLivre = interruptor(
      'φ livre',
      o.phiLivre,
      (v) => {
        o.phiLivre = v;
        app.salvarOpcoes();
      },
      'Se a orientação pedida for inalcançável, usa a mais próxima possível',
    );
    const realCart = h('div', { class: 'real-cart' });
    el.append(
      h(
        'section',
        {},
        h('h3', {}, 'Ponta da ferramenta ', h('small', {}, 'alvo'), h('span', { class: 'dir' }, 'passo ', passoC)),
        grade,
        h('div', { class: 'linha' }, ramoC, ramoB, phiLivre.el),
        realCart,
      ),
    );

    // ---- ações
    const acoes = h(
      'div',
      { class: 'botoes' },
      h('button', { onclick: () => app.moverRobo(app.alvo.q, 'junta'), title: 'Movimento sincronizado das juntas até o alvo' }, 'Mover (juntas)'),
      h('button', { onclick: () => app.moverRobo(app.alvo.q, 'linear'), title: 'Ponta em linha reta até o alvo' }, 'Mover (linear)'),
      h('button', { onclick: () => app.definirAlvo([...app.config.poseInicial]) }, 'Alvo = pose inicial'),
      h('button', { onclick: () => app.real.q && app.definirAlvo([...app.real.q], { seguir: false }) }, 'Alvo = real'),
      h('button', { class: 'aviso', onclick: () => app.ctl.pararSuave() }, 'Parar'),
    );
    const avisos = h('div', { class: 'avisos' });
    el.append(h('section', {}, h('h3', {}, 'Ações'), acoes, avisos));

    // ---- torque
    const barras = [1, 2, 3].map((i) => {
      const barra = h('div', { class: 'barra-preench' });
      const valor = h('span', {}, '—');
      return {
        i,
        barra,
        valor,
        el: h('div', { class: 'linha-torque' }, h('span', {}, app.config.juntas[i].nome), h('div', { class: 'barra' }, barra), valor),
      };
    });
    el.append(
      h(
        'section',
        {},
        h('h3', {}, 'Torque estático no alvo ', h('small', {}, 'gravidade / capacidade')),
        barras.map((b) => b.el),
      ),
    );

    refs = { linhas, cart, realCart, avisos, barras };
    atualizar();
  }

  function atualizar() {
    if (!refs) return;
    const ativo = document.activeElement;
    const q = app.alvo.q;
    refs.linhas.forEach((l, i) => {
      if (ativo !== l.slider) l.slider.value = q[i];
      if (ativo !== l.num) l.num.value = q[i].toFixed(1);
      l.real.textContent = app.real.q ? fmt(app.real.q[i]) : '—';
    });
    const p = app.cin.pose(q);
    for (const k of ['x', 'y', 'z', 'phi']) if (ativo !== refs.cart[k]) refs.cart[k].value = p[k].toFixed(1);
    if (app.real.q) {
      const r = app.cin.pose(app.real.q);
      refs.realCart.textContent = `real: X ${fmt(r.x)}  Y ${fmt(r.y)}  Z ${fmt(r.z)}  φ ${fmt(r.phi)}°`;
    } else refs.realCart.textContent = 'real: —';

    const avisos = [];
    if (!app.alvo.valido) avisos.push(['erro', app.alvo.avisoIK]);
    else if (app.alvo.avisoIK) avisos.push(['aviso', app.alvo.avisoIK]);
    for (const a of app.cin.singularidade(q).avisos) avisos.push(['aviso', a]);
    const ramos = app.cin.ramos(q);
    avisos.push(['info', `Configuração: cotovelo ${ramos.ramoCotovelo}, base ${ramos.ramoBase === 'atras' ? 'atrás' : 'frente'}`]);
    refs.avisos.replaceChildren(...avisos.map(([t, m]) => h('div', { class: t }, m)));

    const tau = torquesEstaticos(app.cin, q, app.config.massas);
    for (const b of refs.barras) {
      const cap = app.config.massas.capacidade[b.i];
      const r = Math.abs(tau[b.i]) / cap;
      b.barra.style.width = `${Math.min(100, r * 100)}%`;
      b.barra.className = `barra-preench ${r > 1 ? 'erro' : r > 0.8 ? 'aviso' : ''}`;
      b.valor.textContent = `${fmt(Math.abs(tau[b.i]), 2)} / ${fmt(cap, 2)} N·m`;
    }
  }

  app.on('config', render);
  render();
  return { el, atualizar };
}
