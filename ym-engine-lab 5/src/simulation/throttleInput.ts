/**
 * Accelerator input tracking.
 *
 * Several sources can hold the pedal at once (a finger, the mouse, a key).
 * The pedal is pressed while at least one source holds it; releasing every
 * source — or calling `releaseAll()` on blur / tab hide / pointer cancel —
 * immediately drops the input to zero. This prevents the classic "stuck
 * accelerator" bug where a lost pointerup leaves the engine revving.
 */
export class ThrottleInput {
  private readonly sources = new Set<string>();
  private override: number | null = null;

  press(sourceId: string): void {
    this.sources.add(sourceId);
  }

  release(sourceId: string): void {
    this.sources.delete(sourceId);
  }

  releaseAll(): void {
    this.sources.clear();
    this.override = null;
  }

  /** Scripted input (blip, launch demo). `null` returns control to the pedal. */
  setOverride(value: number | null): void {
    this.override = value === null ? null : Math.min(1, Math.max(0, value));
  }

  get pressed(): boolean {
    return this.sources.size > 0;
  }

  get hasOverride(): boolean {
    return this.override !== null;
  }

  /** Target throttle 0..1 requested by the driver. */
  get target(): number {
    if (this.sources.size > 0) return 1;
    return this.override ?? 0;
  }
}

/**
 * Converts the requested target into the throttle the engine sees: a progressive
 * rise while held (`riseTime` for 0→1) and a very fast fall on release.
 */
export function stepThrottle(current: number, target: number, dt: number, riseTime: number, fallTime = 0.06): number {
  if (target > current) return Math.min(target, current + dt / Math.max(0.01, riseTime));
  return Math.max(target, current - dt / Math.max(0.005, fallTime));
}
