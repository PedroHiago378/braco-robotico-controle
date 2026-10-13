// Utilidades matemáticas e um emissor de eventos mínimo, sem dependência de DOM.

export const N_JUNTAS = 4;
export const RAD = Math.PI / 180;
export const GRAUS = 180 / Math.PI;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Ângulo em graus para o intervalo (-180, 180]. */
export function wrap180(a) {
  const r = ((((a + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
}

/** Diferença angular mais curta b - a, em graus. */
export const difAngular = (a, b) => wrap180(b - a);

export const copiar = (o) => JSON.parse(JSON.stringify(o));

export function quaseIgual(qa, qb, tol = 1e-6) {
  for (let i = 0; i < qa.length; i++) if (Math.abs(qa[i] - qb[i]) > tol) return false;
  return true;
}

export class Emissor {
  constructor() {
    this._ouvintes = new Map();
  }
  on(evento, fn) {
    if (!this._ouvintes.has(evento)) this._ouvintes.set(evento, new Set());
    this._ouvintes.get(evento).add(fn);
    return () => this._ouvintes.get(evento)?.delete(fn);
  }
  emit(evento, ...args) {
    for (const fn of this._ouvintes.get(evento) ?? []) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`erro no ouvinte de "${evento}"`, e);
      }
    }
  }
}
