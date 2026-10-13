// Painel de configuração do braço: edita um rascunho e aplica com validação.

import { h, fmt, baixarArquivo, abrirArquivo } from './dom.js';
import { configPadrao, normalizarConfig, passosPorGrau, validarConfig } from '../nucleo/config.js';
import { copiar } from '../nucleo/util.js';

const GEOMETRIA = [
  ['alturaOmbro', 'Altura do ombro', 'mm', 'Da mesa até o eixo do ombro'],
  ['offsetOmbro', 'Offset do ombro', 'mm', 'Distância radial do eixo do ombro ao eixo da base (negativo = atrás)'],
  ['L1', 'L1 ombro → cotovelo', 'mm'],
  ['L2', 'L2 cotovelo → punho', 'mm'],
  ['L3', 'L3 punho → ponta', 'mm', 'Comprimento da ferramenta'],
];

const JUNTA = [
  ['min', 'Mínimo', '°'],
  ['max', 'Máximo', '°'],
  ['velMax', 'Vel. máx.', '°/s'],
  ['accMax', 'Acel. máx.', '°/s²'],
  ['passosVolta', 'Passos/volta', 'passos', 'Nema 17 de 1,8° = 200'],
  ['micropassos', 'Micropassos', '×', 'Jumpers MS1/MS2/MS3 do driver'],
  ['reducao', 'Redução', ':1'],
  ['inverter', 'Inverter sentido', 'bool'],
];

const FIM = [
  ['usar', 'Tem fim de curso', 'bool'],
  ['invertido', 'Chave NF', 'bool', 'Normalmente fechada (marque se a chave abre ao ser acionada)'],
  ['limiteRigido', 'Alarme se acionar', 'bool', 'Acionar a chave fora do homing para o robô'],
  ['direcao', 'Busca no sentido', 'dir'],
  ['angulo', 'Ângulo na chave', '°'],
  ['velBusca', 'Vel. de busca', '°/s'],
  ['velFina', 'Vel. fina', '°/s'],
  ['recuo', 'Recuo', '°'],
  ['cursoMax', 'Curso máximo', '°'],
];

const CONTROLE = [
  ['taxaHz', 'Taxa de segmentos', 'Hz', 'Segmentos por segundo enviados ao firmware'],
  ['bufferMs', 'Buffer', 'ms', 'Movimento mantido na fila do firmware (latência do seguimento)'],
  ['velCartesiana', 'Vel. cartesiana', 'mm/s'],
  ['accCartesiana', 'Acel. cartesiana', 'mm/s²'],
  ['velPhi', 'Vel. de φ', '°/s'],
  ['accPhi', 'Acel. de φ', '°/s²'],
  ['folgaVelocidade', 'Trava de velocidade', '× vel. máx.', 'Acima disso o app corta o passo; o firmware recebe 10% a mais'],
];

const MASSAS = [
  ['eloA', 'Elo 1', 'kg'],
  ['eloB', 'Elo 2', 'kg'],
  ['unidadeCotovelo', 'Motor+redutor no cotovelo', 'kg'],
  ['unidadePunho', 'Motor+redutor no punho', 'kg'],
  ['ferramenta', 'Ferramenta', 'kg'],
  ['carga', 'Carga na ponta', 'kg'],
];

export function criarPainelConfig(app) {
  const el = h('div', { class: 'painel' });
  let rascunho = copiar(app.config);
  let mensagens = h('div', { class: 'avisos' });

  function campo(obj, chave, rotulo, unidade, titulo) {
    const v = obj[chave];
    if (unidade === 'bool') {
      const input = h('input', { type: 'checkbox', checked: !!v });
      input.addEventListener('change', () => (obj[chave] = input.checked));
      return h('label', { class: 'campo bool', title: titulo }, input, h('span', {}, rotulo));
    }
    if (unidade === 'dir') {
      const s = h('select', {}, h('option', { value: '-1', selected: v < 0 }, 'negativo (−)'), h('option', { value: '1', selected: v > 0 }, 'positivo (+)'));
      s.addEventListener('change', () => (obj[chave] = Number(s.value)));
      return h('label', { class: 'campo', title: titulo }, h('span', {}, rotulo), s);
    }
    const input = h('input', { type: 'number', step: 'any', value: v });
    input.addEventListener('change', () => {
      obj[chave] = Number(input.value);
      renderInfo();
    });
    return h('label', { class: 'campo', title: titulo }, h('span', {}, rotulo), input, h('small', {}, unidade));
  }

  const infos = [];
  function renderInfo() {
    const tick = app.link.info?.tick ?? 20000;
    infos.forEach((info, i) => {
      const j = rascunho.juntas[i];
      const ppg = passosPorGrau(j);
      const raio = rascunho.geometria.L1 + rascunho.geometria.L2 + rascunho.geometria.L3;
      const vMaxFw = (tick * 0.95) / ppg;
      info.textContent =
        `${fmt(ppg, 2)} passos/° · resolução ${fmt(1 / ppg, 4)}° ` +
        (i <= 1 ? `(≈${fmt((Math.PI / 180 / ppg) * raio, 3)} mm na ponta) ` : '') +
        `· firmware até ${fmt(vMaxFw, 0)} °/s`;
      info.className = `info ${j.velMax * rascunho.controle.folgaVelocidade > vMaxFw ? 'erro' : ''}`;
    });
  }

  function render() {
    el.replaceChildren();
    infos.length = 0;
    const c = rascunho;
    el.append(
      h(
        'section',
        {},
        h('h3', {}, 'Arquivo de configuração'),
        h(
          'div',
          { class: 'botoes' },
          h('button', { class: 'primario', onclick: aplicar }, 'Aplicar'),
          h('button', { onclick: () => recarregar() }, 'Descartar alterações'),
          h('button', { onclick: exportar }, 'Exportar JSON'),
          h('button', { onclick: importar }, 'Importar JSON'),
          h('button', { onclick: restaurar }, 'Restaurar padrão'),
        ),
        mensagens,
      ),
    );
    el.append(
      h(
        'section',
        {},
        h(
          'h3',
          {},
          'Geometria',
          app.geometriaCAD
            ? h('button', { class: 'mini dir', title: 'Copia altura, offset, L1 e L2 do modelo STEP para o rascunho', onclick: usarGeometriaCAD }, 'Usar geometria do CAD')
            : null,
        ),
        h('label', { class: 'campo largo' }, h('span', {}, 'Nome'), nomeInput()),
        h('div', { class: 'grade-campos' }, GEOMETRIA.map(([k, r, u, t]) => campo(c.geometria, k, r, u, t))),
        h('p', { class: 'nota' }, 'Convenção: base gira em z; ombro é absoluto a partir da horizontal; cotovelo e punho são relativos ao elo anterior. Positivo = para cima.'),
      ),
    );
    c.juntas.forEach((j, i) => {
      const info = h('div', { class: 'info' });
      infos.push(info);
      el.append(
        h(
          'section',
          {},
          h('details', { open: i === 0 },
            h('summary', {}, `Junta ${i + 1}: ${j.nome}`),
            h('div', { class: 'grade-campos' }, JUNTA.map(([k, r, u, t]) => campo(j, k, r, u, t))),
            info,
            h('h4', {}, 'Fim de curso / homing'),
            h('div', { class: 'grade-campos' }, FIM.map(([k, r, u, t]) => campo(j.fimDeCurso, k, r, u, t))),
          ),
        ),
      );
    });
    const pose = h(
      'div',
      { class: 'grade-campos' },
      c.juntas.map((j, i) => campo(c.poseInicial, i, j.nome, '°')),
    );
    el.append(
      h(
        'section',
        {},
        h('h3', {}, 'Pose inicial ', h('button', { class: 'mini', onclick: () => ((c.poseInicial = app.alvo.q.map((v) => +v.toFixed(2))), render()) }, 'usar alvo atual')),
        pose,
        h('p', { class: 'nota' }, 'Pose assumida ao conectar sem referência (posicione o braço nela antes de ligar os motores).'),
      ),
    );
    el.append(h('section', {}, h('h3', {}, 'Controle de movimento'), h('div', { class: 'grade-campos' }, CONTROLE.map(([k, r, u, t]) => campo(c.controle, k, r, u, t)))));
    const ordem = h('input', { type: 'text', value: c.homing.ordem.join(', ') });
    ordem.addEventListener('change', () => {
      const v = ordem.value.split(/[,;\s]+/).filter(Boolean).map(Number);
      if (v.every((x) => Number.isInteger(x) && x >= 0 && x < 4)) c.homing.ordem = v;
      else ordem.value = c.homing.ordem.join(', ');
    });
    el.append(
      h(
        'section',
        {},
        h('h3', {}, 'Comunicação e homing'),
        h('div', { class: 'grade-campos' }, campo(c.serial, 'baud', 'Baud', 'bps'), h('label', { class: 'campo', title: '0 = base, 1 = ombro, 2 = cotovelo, 3 = punho' }, h('span', {}, 'Ordem do homing'), ordem)),
      ),
    );
    el.append(
      h(
        'section',
        {},
        h('h3', {}, 'Massas e capacidade (monitor de torque)'),
        h('div', { class: 'grade-campos' }, MASSAS.map(([k, r, u]) => campo(c.massas, k, r, u))),
        h('div', { class: 'grade-campos' }, [1, 2, 3].map((i) => campo(c.massas.capacidade, i, `Capacidade ${c.juntas[i].nome}`, 'N·m'))),
      ),
    );
    renderInfo();
  }

  function usarGeometriaCAD() {
    const g = app.geometriaCAD;
    for (const k of ['alturaOmbro', 'offsetOmbro', 'L1', 'L2']) rascunho.geometria[k] = g[k];
    render();
    mostrar([], [], `Geometria do CAD no rascunho (altura ${g.alturaOmbro}, offset ${g.offsetOmbro}, L1 ${g.L1}, L2 ${g.L2} mm). Clique em Aplicar.`);
  }

  function nomeInput() {
    const i = h('input', { type: 'text', value: rascunho.nome });
    i.addEventListener('change', () => (rascunho.nome = i.value));
    return i;
  }

  function mostrar(erros = [], avisos = [], ok) {
    mensagens.replaceChildren(
      ...erros.map((m) => h('div', { class: 'erro' }, m)),
      ...avisos.map((m) => h('div', { class: 'aviso' }, m)),
      ok ? h('div', { class: 'ok' }, ok) : null,
    );
  }

  async function aplicar() {
    try {
      const r = await app.aplicarConfig(copiar(rascunho));
      if (r.erros.length) return mostrar(r.erros, r.avisos);
      rascunho = copiar(app.config);
      render();
      mostrar([], r.avisos, 'Configuração aplicada e salva.');
    } catch (e) {
      mostrar([e.message]);
    }
  }

  function recarregar() {
    rascunho = copiar(app.config);
    render();
    mostrar();
  }

  function exportar() {
    baixarArquivo(`${(rascunho.nome || 'braco').replace(/[^\w-]+/g, '_')}.config.json`, JSON.stringify(rascunho, null, 2));
  }

  async function importar() {
    try {
      rascunho = normalizarConfig(JSON.parse(await abrirArquivo('.json')));
      render();
      const { erros, avisos } = validarConfig(rascunho, app.link.info?.tick);
      mostrar(erros, avisos, erros.length ? null : 'Importado. Revise e clique em Aplicar.');
    } catch (e) {
      mostrar([`Importação falhou: ${e.message}`]);
    }
  }

  function restaurar() {
    if (!confirm('Substituir o rascunho pelos valores padrão do estudo do CAD?')) return;
    rascunho = configPadrao();
    render();
    mostrar([], [], 'Padrão carregado no rascunho. Clique em Aplicar para usar.');
  }

  app.on('config', () => {
    rascunho = copiar(app.config);
    render();
  });
  app.on('cad', render);
  render();
  return { el };
}
