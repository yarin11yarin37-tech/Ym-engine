/**
 * Phone motion sensor → longitudinal (forward/back) acceleration of the car.
 *
 * A phone in a mount reacts to braking and acceleration within tens of
 * milliseconds, while GPS needs about a second. The catch: we don't know how
 * the phone is mounted. So:
 *  1. Gravity is tracked continuously and removed, leaving the horizontal plane.
 *  2. The forward direction inside that plane is LEARNED by correlating the
 *     phone's horizontal acceleration with GPS acceleration while driving.
 *     Until that is confident, the sensor reports "learning" and the app keeps
 *     using GPS alone — it never guesses a direction and plays it.
 *
 * Pure math lives in `ingest()` / `learn()` so it can be unit-tested; the
 * browser event wiring is in `start()` / `stop()`.
 */

export type MotionStatus = 'off' | 'unsupported' | 'denied' | 'waiting' | 'learning' | 'active';

export interface MotionSample {
  /** Acceleration including gravity, device frame, m/s². */
  withGravity: Vec3;
  /** Acceleration without gravity if the device provides it. */
  linear: Vec3 | null;
}

export type Vec3 = [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const finite = (a: Vec3 | null): a is Vec3 => !!a && a.every((x) => Number.isFinite(x));
const lowpass = (prev: Vec3, next: Vec3, dt: number, tc: number): Vec3 => {
  const k = 1 - Math.exp(-dt / tc);
  return [prev[0] + (next[0] - prev[0]) * k, prev[1] + (next[1] - prev[1]) * k, prev[2] + (next[2] - prev[2]) * k];
};

/** Learning weight (Σ (m/s²)² · s) needed before the direction is trusted. */
const CONFIDENT_WEIGHT = 6;

export class MotionSensor {
  private _status: MotionStatus = 'off';
  private gravity: Vec3 | null = null;
  private horizontal: Vec3 = [0, 0, 0];
  private horizontalSlow: Vec3 = [0, 0, 0];
  private forwardAccum: Vec3 = [0, 0, 0];
  private weight = 0;
  private forward: Vec3 | null = null;
  private longitudinal = 0;
  private lastSampleAt = -Infinity;
  private listeners = new Set<(s: MotionStatus) => void>();
  private handler: ((e: DeviceMotionEvent) => void) | null = null;

  constructor(private readonly clock: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) {}

  get status(): MotionStatus {
    return this._status;
  }

  /** Smoothed forward acceleration of the car (m/s², + = speeding up). Only meaningful when `active`. */
  get acceleration(): number {
    return this.longitudinal;
  }

  /** 0..1 confidence in the learned forward direction. */
  get confidence(): number {
    return Math.min(1, this.weight / CONFIDENT_WEIGHT);
  }

  /** True when samples are arriving and the direction is learned. */
  get usable(): boolean {
    return this._status === 'active' && this.forward !== null && this.clock() - this.lastSampleAt < 500;
  }

  onStatus(fn: (s: MotionStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: MotionStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.listeners.forEach((fn) => fn(s));
  }

  static isSupported(): boolean {
    return typeof window !== 'undefined' && typeof DeviceMotionEvent !== 'undefined';
  }

  /**
   * Must be called from a tap (iOS asks for permission). The permission request
   * is issued synchronously, before any await, so it stays inside the gesture.
   */
  start(): Promise<MotionStatus> {
    if (this.handler) return Promise.resolve(this._status);
    if (!MotionSensor.isSupported()) {
      this.setStatus('unsupported');
      return Promise.resolve('unsupported');
    }
    const DME = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> };
    const permission = typeof DME.requestPermission === 'function' ? DME.requestPermission() : Promise.resolve('granted' as const);
    return permission.then(
      (result) => {
        if (result !== 'granted') {
          this.setStatus('denied');
          return this._status;
        }
        this.attach();
        return this._status;
      },
      () => {
        // Called outside a gesture, or blocked.
        this.setStatus('denied');
        return this._status;
      },
    );
  }

  private attach(): void {
    if (this.handler) return;
    this.handler = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity;
      const l = e.acceleration;
      const withGravity: Vec3 = [g?.x ?? NaN, g?.y ?? NaN, g?.z ?? NaN];
      const linear: Vec3 | null = l && l.x !== null ? [l.x ?? NaN, l.y ?? NaN, l.z ?? NaN] : null;
      this.ingest({ withGravity, linear }, this.clock());
    };
    window.addEventListener('devicemotion', this.handler);
    this.setStatus(this.forward ? 'active' : 'waiting');
  }

  stop(): void {
    if (this.handler && typeof window !== 'undefined') window.removeEventListener('devicemotion', this.handler);
    this.handler = null;
    this.longitudinal = 0;
    this.lastSampleAt = -Infinity;
    if (this._status !== 'unsupported' && this._status !== 'denied') this.setStatus('off');
  }

  /** Forget the learned mounting direction (phone was moved). */
  recalibrate(): void {
    this.forwardAccum = [0, 0, 0];
    this.weight = 0;
    this.forward = null;
    this.longitudinal = 0;
    if (this.handler || this._status === 'active') this.setStatus('learning');
  }

  /** Process one sensor sample. */
  ingest(sample: MotionSample, nowMs: number): void {
    if (!finite(sample.withGravity)) return;
    const dt = Number.isFinite(this.lastSampleAt) ? Math.min(0.2, Math.max(0.001, (nowMs - this.lastSampleAt) / 1000)) : 0.016;
    this.lastSampleAt = nowMs;

    // Gravity: exact when the device separates it, otherwise a slow low-pass.
    const gNow = finite(sample.linear) ? sub(sample.withGravity, sample.linear) : sample.withGravity;
    // Without separate gravity data, track it slowly so sustained braking isn't mistaken for tilt.
    this.gravity = this.gravity ? lowpass(this.gravity, gNow, dt, finite(sample.linear) ? 0.3 : 5) : gNow;
    const gLen = len(this.gravity);
    if (gLen < 3) return; // free fall / garbage
    const up = scale(this.gravity, 1 / gLen);

    const linear = finite(sample.linear) ? sample.linear : sub(sample.withGravity, this.gravity);
    const h = sub(linear, scale(up, dot(linear, up)));
    this.horizontal = lowpass(this.horizontal, h, dt, 0.06);
    this.horizontalSlow = lowpass(this.horizontalSlow, h, dt, 0.8);

    if (this.forward) {
      // Re-project onto the current horizontal plane in case the phone tilted slightly.
      const fh = sub(this.forward, scale(up, dot(this.forward, up)));
      const fl = len(fh);
      if (fl > 0.2) this.forward = scale(fh, 1 / fl);
      const raw = dot(this.horizontal, this.forward);
      this.longitudinal += (raw - this.longitudinal) * (1 - Math.exp(-dt / 0.05));
    }
    if (this._status === 'waiting' || this._status === 'off') this.setStatus(this.forward ? 'active' : 'learning');
  }

  /**
   * Teach the forward direction from GPS. Call each frame with the GPS-derived
   * acceleration (m/s²) while GPS is fresh. Only clear accelerations/brakings count.
   */
  learn(gpsAcceleration: number, dt: number): void {
    if (!Number.isFinite(gpsAcceleration) || Math.abs(gpsAcceleration) < 0.6) return;
    if (len(this.horizontalSlow) < 0.25) return;
    // Horizontal acceleration that coincides with GPS speeding up points forward;
    // during braking it points backward, so multiplying by the GPS sign aligns both.
    this.forwardAccum = add(scale(this.forwardAccum, Math.exp(-dt / 120)), scale(this.horizontalSlow, gpsAcceleration * dt));
    this.weight = Math.min(CONFIDENT_WEIGHT * 4, this.weight + Math.abs(gpsAcceleration) * len(this.horizontalSlow) * dt);
    const fl = len(this.forwardAccum);
    if (this.weight >= CONFIDENT_WEIGHT && fl > 1e-6) {
      this.forward = scale(this.forwardAccum, 1 / fl);
      if (this._status === 'learning' || this._status === 'waiting') this.setStatus('active');
    }
  }
}

export const MOTION_STATUS_LABEL: Record<MotionStatus, string> = {
  off: 'Motion sensor off',
  unsupported: 'No motion sensor',
  denied: 'Motion sensor blocked',
  waiting: 'Motion sensor starting',
  learning: 'Learning phone direction',
  active: 'Motion sensor active',
};
