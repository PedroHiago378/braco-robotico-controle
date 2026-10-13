// Protocolo texto entre o app e o firmware (uma linha por comando, resposta "ok" ou "erro N").
//
// Host -> firmware
//   V                         identificação (responde a linha BRACO ... e ok)
//   S <us> <p1> <p2> <p3> <p4>  segmento: ir às posições absolutas (passos) em <us> microssegundos
//   Z <p1> <p2> <p3> <p4>     define a posição atual (referência manual)
//   E <0|1>                   desliga/liga os drivers
//   M <v1> <v2> <v3> <v4>     velocidade máxima de segurança por eixo (passos/s)
//   L <ativos> <invertidos>   máscaras de fim de curso: limite rígido e chave NF
//   H <eixo> <dir> <vRap> <vLenta> <recuo> <curso> <home>   homing de um eixo (passos, passos/s)
//   X                         destrava alarme
//   W                         espera a fila esvaziar
// Tempo real (um caractere, sem fim de linha, sem "ok"):
//   ?  pede status    !  parada de emergência (esvazia a fila e entra em alarme)
//
// Firmware -> host
//   BRACO <versao> eixos=4 tick=<Hz> rx=<bytes> fila=<segmentos> ref=<0|1>
//   <ESTADO[:alarme]|p1,p2,p3,p4|fila|ms|fins|motores|ref>
//   ok | erro <n> <texto> | ALARME <n> <texto> | MSG <texto>

export const ERROS = {
  1: 'comando desconhecido',
  2: 'parâmetros inválidos',
  3: 'alarme ativo (use Destravar)',
  4: 'homing falhou (chave não encontrada)',
  5: 'ocupado',
  6: 'motores desligados',
  7: 'linha longa demais',
};

export const ALARMES = {
  1: 'parada de emergência',
  2: 'fim de curso acionado',
  3: 'falha no homing',
  4: 'botão de emergência',
};

export const formatarSegmento = (us, passos) => `S ${Math.round(us)} ${passos.join(' ')}`;

export function parseHello(linha) {
  const m = /^BRACO\s+(\S+)(.*)$/.exec(linha.trim());
  if (!m) return null;
  const info = { versao: m[1], eixos: 4, tick: 20000, rx: 64, fila: 16, ref: false };
  for (const par of m[2].trim().split(/\s+/)) {
    const [k, v] = par.split('=');
    if (k === 'ref') info.ref = v === '1';
    else if (k in info) info[k] = Number(v);
  }
  return info;
}

export function parseStatus(linha) {
  const l = linha.trim();
  if (!l.startsWith('<') || !l.endsWith('>')) return null;
  const partes = l.slice(1, -1).split('|');
  if (partes.length < 7) return null;
  const [est, pos, fila, ms, fins, en, ref] = partes;
  const [estado, alarme] = est.split(':');
  return {
    estado,
    alarme: alarme ? Number(alarme) : 0,
    passos: pos.split(',').map(Number),
    fila: Number(fila),
    bufferMs: Number(ms),
    fins: [...fins].map((c) => c === '1'),
    motores: en === '1',
    ref: ref === '1',
  };
}

export function formatarStatus(s) {
  const est = s.alarme ? `${s.estado}:${s.alarme}` : s.estado;
  return `<${est}|${s.passos.join(',')}|${s.fila}|${Math.round(s.bufferMs)}|${s.fins.map((f) => (f ? 1 : 0)).join('')}|${s.motores ? 1 : 0}|${s.ref ? 1 : 0}>`;
}
