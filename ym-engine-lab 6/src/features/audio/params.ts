/**
 * AudioParam helpers. `setParam` schedules a smooth approach and skips calls that
 * would not audibly change anything, keeping the automation timeline short even
 * though the engine updates every animation frame.
 */
const lastValues = new WeakMap<AudioParam, number>();

export function setParam(param: AudioParam, value: number, now: number, timeConstant = 0.03, epsilon = 1e-4): void {
  if (!Number.isFinite(value)) return;
  const last = lastValues.get(param);
  if (last !== undefined && Math.abs(last - value) <= epsilon * Math.max(1, Math.abs(value))) return;
  lastValues.set(param, value);
  try {
    param.setTargetAtTime(value, now, timeConstant);
  } catch {
    param.value = value;
  }
}

/** Forget the cached value (after cancelScheduledValues or a hard set). */
export function resetParam(param: AudioParam, value: number): void {
  lastValues.set(param, value);
}

/** Soft-clip curve for the exhaust saturation stage. */
export function makeSaturationCurve(samples = 2048, hardness = 2.5): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const norm = Math.tanh(hardness);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    // Slight asymmetry adds even harmonics, which reads as "exhaust" rather than "fuzz".
    const y = Math.tanh(hardness * (x + 0.08 * x * x)) / norm;
    curve[i] = Math.max(-1, Math.min(1, y));
  }
  return curve;
}

/** Shared white-noise buffer (generated once per context). */
export function makeNoiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 1234567;
  let b0 = 0;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const white = seed / 4294967296 - 0.5;
    // Gentle low-pass tilt: noise that sounds like air rather than hiss.
    b0 = 0.86 * b0 + 0.14 * white;
    data[i] = (white * 0.5 + b0 * 1.6) * 1.4;
  }
  return buf;
}
