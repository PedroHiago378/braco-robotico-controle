// Perfis de movimento normalizados (distância 0 -> 1).

/**
 * Perfil trapezoidal para distância 1 com velocidade V (1/s) e aceleração A (1/s²).
 * Vira triangular quando não há distância para atingir V.
 */
export function perfilTrapezoidal(V, A) {
  let Ta = V / A;
  let Da = 0.5 * A * Ta * Ta;
  if (2 * Da > 1) {
    Ta = Math.sqrt(1 / A);
    V = A * Ta;
    Da = 0.5;
  }
  const Tc = (1 - 2 * Da) / V;
  const T = 2 * Ta + Tc;
  const s = (t) => {
    if (t <= 0) return 0;
    if (t >= T) return 1;
    if (t < Ta) return 0.5 * A * t * t;
    if (t < Ta + Tc) return Da + V * (t - Ta);
    const u = T - t;
    return 1 - 0.5 * A * u * u;
  };
  return { T, V, A, s };
}

/** Quíntica "smootherstep": velocidade e aceleração nulas nas pontas. */
export const suave5 = (u) => u * u * u * (u * (u * 6 - 15) + 10);
/** Pico de ds/du da quíntica (em u = 0,5) e de d²s/du² (em u = 0,5 ± √3/6). */
export const SUAVE5_VMAX = 1.875;
export const SUAVE5_AMAX = 10 / Math.sqrt(3);

/** Hermite cúbica no intervalo de duração h, com u em [0,1]; m0/m1 em unidades/s. */
export function hermite(p0, p1, m0, m1, u, h) {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * h * m1
  );
}
