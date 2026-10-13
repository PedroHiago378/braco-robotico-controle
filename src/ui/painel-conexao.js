// Painel de conexão: simulador ou serial, motores, referência/homing, alarme, status e log.

import { h, fmt, seletor, interruptor } from './dom.js';
import { TransporteSerial } from '../hardware/serial.js';
import { ALARMES } from '../hardware/protocolo.js';

export function criarPainelConexao(app) {
  const { link } = app;
  const el = h('div', { class: 'painel' });
  const o = app.opcoes;

  const suportaSerial = TransporteSerial.suportado();
  const tipo = seletor(
    { simulador: 'Simulador (sem hardware)', serial: suportaSerial ? 'Serial USB (Arduino/ESP32)' : 'Serial USB (indisponível)' },
    app.conexao.tipo,
    (v) => (app.conexao.tipo = v),
  );
  const baud = h('input', { type: 'number', value: app.config.serial.baud, step: 1, style: { width: '7em' } });
  const btnConectar = h('button', { class: 'primario', onclick: () => app.conectar(tipo.value, Number(baud.value)) }, 'Conectar');
  const btnDesconectar = h('button', { onclick: () => app.desconectar() }, 'Desconectar');
  const info = h('div', { class: 'info' });

  el.append(
    h(
      'section',
      {},
      h('h3', {}, 'Conexão'),
      h('div', { class: 'linha' }, tipo, h('label', { class: 'campo' }, h('span', {}, 'baud'), baud)),
      h('div', { class: 'botoes' }, btnConectar, btnDesconectar),
      suportaSerial ? null : h('div', { class: 'aviso' }, 'Web Serial exige Chrome ou Edge, em localhost ou https.'),
      info,
    ),
  );

  // ---- motores, referência, alarme
  const exec = (fn, ok) => async () => {
    try {
      await fn();
      if (ok) app.notificar(ok, 'ok');
    } catch (e) {
      app.notificar(e.message, 'erro');
    }
  };
  const btnLigar = h('button', { onclick: exec(() => app.motores(true)) }, 'Ligar motores');
  const btnDesligar = h(
    'button',
    {
      onclick: exec(async () => {
        if (!confirm('Desligar os drivers? O braço pode cair por gravidade.')) return;
        await app.motores(false);
      }),
    },
    'Desligar motores',
  );
  const btnHoming = h('button', { onclick: exec(() => app.homing(), 'Homing concluído') }, 'Homing (fins de curso)');
  const btnRefInicial = h(
    'button',
    {
      title: 'Declara que o braço está fisicamente na pose inicial configurada',
      onclick: exec(async () => {
        if (!confirm('O braço está fisicamente na POSE INICIAL configurada?')) return;
        await app.referenciar([...app.config.poseInicial]);
      }, 'Referência definida'),
    },
    'Ref. = pose inicial',
  );
  const btnRefAlvo = h(
    'button',
    {
      title: 'Declara que o braço está fisicamente na pose do alvo (fantasma)',
      onclick: exec(async () => {
        if (!confirm('O braço está fisicamente na pose do ALVO (fantasma)?')) return;
        await app.referenciar([...app.alvo.q]);
      }, 'Referência definida'),
    },
    'Ref. = alvo',
  );
  const btnDestravar = h('button', { class: 'aviso', onclick: exec(() => app.destravar(), 'Alarme destravado') }, 'Destravar alarme');
  el.append(
    h(
      'section',
      {},
      h('h3', {}, 'Robô'),
      h('div', { class: 'botoes' }, btnLigar, btnDesligar),
      h('div', { class: 'botoes' }, btnHoming, btnRefInicial, btnRefAlvo),
      h('div', { class: 'botoes' }, btnDestravar),
      h(
        'p',
        { class: 'nota' },
        'Sem fins de curso: posicione o braço à mão na pose inicial antes de ligar os motores e use "Ref. = pose inicial".',
      ),
    ),
  );

  // ---- status
  const campos = {};
  const grade = h(
    'div',
    { class: 'grade-status' },
    ['Estado', 'Motores', 'Referência', 'Fila', 'Buffer', 'Fins de curso', 'Passos', 'Modo'].map((n) => {
      campos[n] = h('span', {}, '—');
      return [h('span', { class: 'rot' }, n), campos[n]];
    }),
  );
  el.append(h('section', {}, h('h3', {}, 'Status do firmware'), grade));

  // ---- log
  const log = h('div', { class: 'log' });
  const mostrarSeg = interruptor('segmentos', o.logSegmentos, (v) => (o.logSegmentos = v));
  const mostrarStatus = interruptor('status', o.logStatus, (v) => (o.logStatus = v));
  el.append(
    h(
      'section',
      {},
      h(
        'h3',
        {},
        'Log ',
        h('span', { class: 'dir' }, mostrarSeg.el, mostrarStatus.el, h('button', { class: 'mini', onclick: () => log.replaceChildren() }, 'limpar')),
      ),
      log,
    ),
  );

  const adicionarLog = (texto, cls) => {
    const fim = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.append(h('div', { class: cls }, texto));
    while (log.childElementCount > 300) log.firstChild.remove();
    if (fim) log.scrollTop = log.scrollHeight;
  };
  link.on('enviado', (l) => {
    if (l.startsWith('S ') && !o.logSegmentos) return;
    adicionarLog('> ' + l, 'tx');
  });
  link.on('linha', (l) => {
    if (l === 'ok' && !o.logSegmentos) return;
    adicionarLog(l, l.startsWith('erro') || l.startsWith('ALARME') ? 'erro' : 'rx');
  });
  link.on('status', (s) => {
    if (o.logStatus) adicionarLog(`<${s.estado}|${s.passos.join(',')}|${s.fila}|${s.bufferMs}>`, 'st');
  });
  link.on('mensagem', (m) => adicionarLog('# ' + m, 'msg'));
  app.on('log', (m) => adicionarLog('# ' + m, 'msg'));

  function atualizar() {
    const pronto = link.pronto;
    btnConectar.disabled = link.estado !== 'desconectado';
    btnDesconectar.disabled = link.estado === 'desconectado';
    tipo.disabled = baud.disabled = link.estado !== 'desconectado';
    for (const b of [btnLigar, btnDesligar, btnHoming, btnRefInicial, btnRefAlvo, btnDestravar]) b.disabled = !pronto;
    info.textContent = link.info
      ? `${app.conexao.nome ?? ''} — firmware ${link.info.versao}, ${link.info.tick} passos/s por eixo, fila ${link.info.fila}, rx ${link.info.rx} B`
      : link.estado === 'conectando'
        ? 'Conectando…'
        : 'Desconectado';
    const s = link.status;
    if (!s || !pronto) {
      for (const c of Object.values(campos)) c.textContent = '—';
      return;
    }
    campos.Estado.textContent = s.alarme ? `ALARME: ${ALARMES[s.alarme] ?? s.alarme}` : s.estado;
    campos.Estado.className = s.alarme ? 'erro' : s.estado === 'MOVENDO' ? 'ok' : '';
    campos.Motores.textContent = s.motores ? 'ligados' : 'desligados';
    campos.Motores.className = s.motores ? 'ok' : 'aviso';
    campos['Referência'].textContent = s.ref ? 'definida' : 'não definida';
    campos.Fila.textContent = `${s.fila} segmentos`;
    campos.Buffer.textContent = `${fmt(s.bufferMs, 0)} ms`;
    campos['Fins de curso'].textContent = s.fins.map((f, i) => `${app.config.juntas[i].nome[0]}:${f ? '■' : '□'}`).join(' ');
    campos.Passos.textContent = s.passos.join(', ');
    campos.Modo.textContent = app.ctl.modo + (app.ctl.pausado ? ' (pausado)' : '');
  }

  return { el, atualizar };
}
