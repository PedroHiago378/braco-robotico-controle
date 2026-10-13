// Operações de alto nível com o robô: conectar, referenciar, homing, motores, alarme.
// `app` = { config, link, ctl }.

import { grausParaPassos, passosParaGraus, passosPorGrau } from './config.js';

/** Envia ao firmware a trava de velocidade (M) e as máscaras de fim de curso (L). */
export async function enviarParametros({ config, link }) {
  const vmax = config.juntas.map((j) =>
    Math.max(1, Math.round(j.velMax * config.controle.folgaVelocidade * 1.1 * passosPorGrau(j))),
  );
  let ativos = 0;
  let invertidos = 0;
  config.juntas.forEach((j, i) => {
    if (j.fimDeCurso.usar && j.fimDeCurso.limiteRigido) ativos |= 1 << i;
    if (j.fimDeCurso.invertido) invertidos |= 1 << i;
  });
  await link.comando(`M ${vmax.join(' ')}`);
  await link.comando(`L ${ativos} ${invertidos}`);
}

/**
 * Conecta e estabelece a referência. Se o firmware acabou de ligar (ref=0), assume que o
 * braço está na pose inicial. Se já tinha referência, adota a posição dele.
 */
export async function conectar(app, transporte) {
  const { config, link, ctl } = app;
  const info = await link.conectar(transporte);
  await enviarParametros(app);
  const s = await link.statusAgora();
  let assumida = false;
  if (!s.ref) {
    await link.comando(`Z ${grausParaPassos(config, config.poseInicial).join(' ')}`);
    ctl.sincronizar(config.poseInicial);
    assumida = true;
  } else {
    ctl.sincronizar(passosParaGraus(config, s.passos));
  }
  return { info, assumida };
}

/** Referência manual: declara que o braço está fisicamente na pose q. */
export async function referenciar({ config, link, ctl }, q) {
  await ctl.pararEsperar();
  await link.comando('W');
  await link.comando(`Z ${grausParaPassos(config, q).join(' ')}`);
  ctl.sincronizar(q);
}

export async function ligarMotores({ link }, ligar) {
  await link.comando(`E ${ligar ? 1 : 0}`);
}

export async function destravar({ config, link, ctl }) {
  await link.comando('X');
  const s = await link.statusAgora();
  ctl.sincronizar(passosParaGraus(config, s.passos));
}

/** Homing das juntas com fim de curso, na ordem configurada. */
export async function homing(app, aoProgresso = () => {}) {
  const { config, link, ctl } = app;
  const ordem = config.homing.ordem.filter((i) => config.juntas[i]?.fimDeCurso.usar);
  if (!ordem.length) throw new Error('Nenhuma junta com fim de curso habilitado (Configuração > Juntas).');
  await ctl.pararEsperar();
  ctl.bloqueado = true;
  try {
    await link.comando('W');
    for (const i of ordem) {
      const j = config.juntas[i];
      const fc = j.fimDeCurso;
      const ppg = passosPorGrau(j);
      const sinal = j.inverter ? -1 : 1;
      const dir = fc.direcao * sinal > 0 ? 1 : -1;
      const home = Math.round(fc.angulo * ppg * sinal);
      aoProgresso(`Homing: ${j.nome}`);
      await link.comando(
        `H ${i} ${dir} ${Math.round(fc.velBusca * ppg)} ${Math.round(fc.velFina * ppg)} ` +
          `${Math.round(fc.recuo * ppg)} ${Math.round(fc.cursoMax * ppg)} ${home}`,
      );
    }
    const s = await link.statusAgora();
    ctl.sincronizar(passosParaGraus(config, s.passos));
  } finally {
    ctl.bloqueado = false;
  }
}
