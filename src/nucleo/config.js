// Configuração do braço: geometria, juntas/motores, controle e massas.
// Valores padrão vêm do estudo em Projetos/braco-robotico (CAD braço.step).
// Itens marcados [suposição] não vêm do CAD e devem ser medidos.

import { N_JUNTAS, copiar } from './util.js';

export const VERSAO_CONFIG = 2;

// Redutor planetário de 2 estágios: sol 15, coroa 49 -> (1 + 49/15)^2 = 18,204:1
export const REDUCAO_CAD = (1 + 49 / 15) ** 2;

function junta(id, nome, min, max, velMax, accMax, fim) {
  return {
    id,
    nome,
    min, // graus
    max, // graus
    passosVolta: 200, // Nema 17, 1,8°
    micropassos: 16, // [suposição] jumpers do driver
    reducao: REDUCAO_CAD,
    inverter: false, // inverte o sentido do motor
    velMax, // °/s na junta
    accMax, // °/s² na junta
    fimDeCurso: {
      usar: false, // há chave nesta junta?
      invertido: false, // chave NF (normalmente fechada)
      limiteRigido: false, // acionar a chave fora do homing gera alarme
      direcao: fim.direcao, // sentido da busca: -1 ou +1 (em graus da junta)
      angulo: fim.angulo, // ângulo da junta quando a chave aciona
      velBusca: 15, // °/s
      velFina: 3, // °/s
      recuo: 4, // graus
      cursoMax: Math.abs(max - min) + 20, // graus; acima disso o homing falha
    },
  };
}

export function configPadrao() {
  return {
    versao: VERSAO_CONFIG,
    nome: 'Braço RRRR — 4 × Nema 17',
    geometria: {
      alturaOmbro: 117.37, // mm, fundo da placa de montagem até o eixo do ombro (CAD)
      offsetOmbro: -49.8, // mm, deslocamento radial do ombro em relação ao eixo da base (CAD)
      L1: 190, // mm, ombro -> cotovelo (CAD)
      L2: 190, // mm, cotovelo -> punho (CAD)
      L3: 100, // mm, punho -> ponta da ferramenta [suposição]
    },
    // Convenção (igual ao estudo): q1 = yaw da base; t1 = ombro, absoluto a partir da horizontal;
    // t2 = cotovelo, relativo ao elo 1; t3 = punho, relativo ao elo 2. Positivo = para cima.
    juntas: [
      junta('base', 'Base', -180, 180, 60, 120, { direcao: -1, angulo: -180 }),
      junta('ombro', 'Ombro', -45, 135, 30, 60, { direcao: 1, angulo: 135 }),
      junta('cotovelo', 'Cotovelo', -90, 90, 40, 80, { direcao: -1, angulo: -90 }),
      junta('punho', 'Punho', -120, 120, 60, 150, { direcao: 1, angulo: 120 }),
    ],
    poseInicial: [0, 60, -60, 0],
    controle: {
      taxaHz: 50, // segmentos por segundo enviados ao firmware
      bufferMs: 250, // tempo de movimento mantido na fila do firmware
      velCartesiana: 80, // mm/s
      accCartesiana: 250, // mm/s²
      velPhi: 45, // °/s (orientação da ferramenta)
      accPhi: 150, // °/s²
      folgaVelocidade: 1.25, // trava de segurança: acima de velMax × isso, o passo é cortado
    },
    serial: { baud: 115200 },
    homing: { ordem: [3, 2, 1, 0] }, // punho, cotovelo, ombro, base
    massas: {
      // kg; do estudo de viabilidade
      eloA: 0.114,
      eloB: 0.128,
      unidadeCotovelo: 0.438, // motor + redutor no cotovelo
      unidadePunho: 0.438, // motor + redutor no punho
      ferramenta: 0.05, // [suposição]
      carga: 0,
      capacidade: [5.0, 3.35, 3.35, 3.35], // N·m úteis por junta (ensaio 5,03 N·m / fator 1,5)
    },
  };
}

export function passosPorGrau(j) {
  return (j.passosVolta * j.micropassos * j.reducao) / 360;
}

export function grausParaPassos(config, q) {
  return config.juntas.map((j, i) => Math.round(q[i] * passosPorGrau(j) * (j.inverter ? -1 : 1)));
}

export function passosParaGraus(config, p) {
  return config.juntas.map((j, i) => (p[i] / passosPorGrau(j)) * (j.inverter ? -1 : 1));
}

/** Mescla recursiva: tudo que faltar em `parcial` vem de `base`. Arrays de juntas por índice. */
export function mesclar(base, parcial) {
  if (parcial === undefined || parcial === null) return copiar(base);
  if (Array.isArray(base)) {
    if (!Array.isArray(parcial)) return copiar(base);
    if (base.length && typeof base[0] === 'object')
      return base.map((b, i) => mesclar(b, parcial[i]));
    return base.map((b, i) => (typeof parcial[i] === typeof b ? parcial[i] : b));
  }
  if (typeof base === 'object') {
    const out = {};
    for (const k of Object.keys(base)) out[k] = mesclar(base[k], parcial[k]);
    return out;
  }
  return typeof parcial === typeof base ? parcial : base;
}

export function normalizarConfig(parcial) {
  const c = mesclar(configPadrao(), parcial);
  // versão 1 usava 100 mm de altura do ombro por suposição; o CAD dá 117,37 mm
  if (parcial && (parcial.versao ?? 1) < 2 && c.geometria.alturaOmbro === 100) c.geometria.alturaOmbro = 117.37;
  c.versao = VERSAO_CONFIG;
  return c;
}

/**
 * Valida a configuração. `tickHz` é a frequência do firmware (limita passos/s).
 * Retorna { erros: string[], avisos: string[] }.
 */
export function validarConfig(c, tickHz = 20000) {
  const erros = [];
  const avisos = [];
  const g = c.geometria;
  for (const k of ['L1', 'L2']) if (!(g[k] > 0)) erros.push(`Geometria: ${k} deve ser > 0`);
  if (!(g.L3 >= 0)) erros.push('Geometria: L3 deve ser ≥ 0');
  if (c.juntas.length !== N_JUNTAS) erros.push(`São necessárias ${N_JUNTAS} juntas`);
  c.juntas.forEach((j, i) => {
    const n = j.nome || `J${i + 1}`;
    if (!(j.max > j.min)) erros.push(`${n}: máximo deve ser maior que mínimo`);
    if (!(j.velMax > 0) || !(j.accMax > 0)) erros.push(`${n}: velocidade e aceleração devem ser > 0`);
    if (!(j.passosVolta > 0 && j.micropassos > 0 && j.reducao > 0))
      erros.push(`${n}: passos, micropassos e redução devem ser > 0`);
    const pps = j.velMax * c.controle.folgaVelocidade * passosPorGrau(j);
    if (pps > tickHz * 0.95)
      avisos.push(
        `${n}: ${Math.round(pps)} passos/s excede o firmware (${tickHz} passos/s). ` +
          `Máximo ≈ ${((tickHz * 0.95) / passosPorGrau(j) / c.controle.folgaVelocidade).toFixed(0)} °/s; reduza micropassos ou velocidade.`,
      );
    if (j.fimDeCurso.usar) {
      const a = j.fimDeCurso.angulo;
      if (a < j.min - 1e-9 || a > j.max + 1e-9) avisos.push(`${n}: ângulo do fim de curso fora dos limites`);
    }
    const qi = c.poseInicial[i];
    if (qi < j.min || qi > j.max) erros.push(`${n}: pose inicial (${qi}°) fora dos limites`);
  });
  if (!(c.controle.taxaHz >= 10 && c.controle.taxaHz <= 200)) erros.push('Controle: taxa deve estar entre 10 e 200 Hz');
  if (!(c.controle.bufferMs >= 2000 / c.controle.taxaHz))
    erros.push('Controle: buffer deve conter ao menos 2 segmentos');
  return { erros, avisos };
}
