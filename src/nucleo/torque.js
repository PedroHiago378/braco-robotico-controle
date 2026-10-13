// Torque estático (gravidade) nas juntas de pitch, com a base de eixo vertical.
// Modelo do estudo de viabilidade: elos com massa no meio, unidade motor+redutor
// concentrada na junta que ela aciona, ferramenta no meio de L3 e carga na ponta.

const G = 9.81;

/** Retorna [base, ombro, cotovelo, punho] em N·m (sinal: positivo puxa a junta para baixo). */
export function torquesEstaticos(cin, q, m) {
  const p = cin.plano(q);
  const rA = (p.rS + p.rE) / 2;
  const rB = (p.rE + p.rW) / 2;
  const rF = (p.rW + p.rT) / 2;
  const punho = m.ferramenta * (rF - p.rW) + m.carga * (p.rT - p.rW);
  const cotovelo =
    m.eloB * (rB - p.rE) + m.unidadePunho * (p.rW - p.rE) + m.ferramenta * (rF - p.rE) + m.carga * (p.rT - p.rE);
  const ombro =
    m.eloA * (rA - p.rS) +
    m.unidadeCotovelo * (p.rE - p.rS) +
    m.eloB * (rB - p.rS) +
    m.unidadePunho * (p.rW - p.rS) +
    m.ferramenta * (rF - p.rS) +
    m.carga * (p.rT - p.rS);
  // kg · mm · m/s² = N·mm -> N·m
  return [0, ombro, cotovelo, punho].map((v) => (v * G) / 1000);
}
