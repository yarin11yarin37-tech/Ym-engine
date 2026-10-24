export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Inverse lerp clamped to 0..1. */
export const progress = (v: number, a: number, b: number): number => (b === a ? 0 : clamp((v - a) / (b - a), 0, 1));

/**
 * Frame-rate independent exponential smoothing toward a target.
 * `timeConstant` is the time (s) to cover ~63 % of the remaining distance.
 */
export function smoothToward(current: number, target: number, dt: number, timeConstant: number): number {
  if (!(timeConstant > 0)) return target;
  const k = 1 - Math.exp(-dt / timeConstant);
  return current + (target - current) * k;
}

/** Linear ramp with a maximum rate (units per second). */
export function rampToward(current: number, target: number, dt: number, ratePerSecond: number): number {
  const step = ratePerSecond * dt;
  if (target > current) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const msToKmh = (ms: number): number => ms * 3.6;
export const kmhToMs = (kmh: number): number => kmh / 3.6;
