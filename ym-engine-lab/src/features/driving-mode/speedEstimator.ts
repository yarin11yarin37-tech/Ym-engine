/**
 * Turns raw geolocation fixes into a smooth, conservative speed estimate.
 *
 * - Prefers the device-reported speed; falls back to distance/time between fixes.
 * - Rejects fixes that are inaccurate, non-finite, out of order or physically implausible.
 * - Smooths speed and derives acceleration from the filtered speed.
 * - Dead-reckons briefly between fixes (GPS is often ~1 Hz) so the sound doesn't step.
 * - Declares the data stale after `staleMs` with no valid fix.
 *
 * Pure logic: no browser APIs, fully unit-tested. Coordinates are only used to
 * compute distance and are never stored beyond the previous fix.
 */
import { clamp, isFiniteNumber, smoothToward } from '../../utils/math';

export interface GpsFix {
  /** ms since epoch (GeolocationPosition.timestamp) */
  timestamp: number;
  latitude: number;
  longitude: number;
  /** metres (95 % radius as reported by the browser) */
  accuracy: number;
  /** m/s or null when the device doesn't report it */
  speed: number | null;
}

export type FixQuality = 'good' | 'poor-accuracy' | 'invalid';

export interface EstimatorOptions {
  /** Max accuracy radius (m) for using positions to compute speed. */
  maxAccuracyM: number;
  /** Max accuracy radius (m) for trusting a device-reported speed (speed is measured independently of position). */
  maxAccuracyForSpeedM: number;
  staleMs: number;
  maxSpeedMs: number;
  maxAccelMs2: number;
  speedTimeConstant: number;
  accelTimeConstant: number;
  maxExtrapolateMs: number;
  /** Preferred baseline between two positions when deriving speed from movement. */
  baselineMs: number;
  /** Longest baseline accepted (covers browsers that update every few seconds). */
  maxBaselineMs: number;
}

export const DEFAULT_ESTIMATOR_OPTIONS: EstimatorOptions = {
  maxAccuracyM: 50,
  maxAccuracyForSpeedM: 150,
  staleMs: 9000,
  maxSpeedMs: 95, // ~340 km/h — anything above is a glitch
  maxAccelMs2: 12,
  speedTimeConstant: 0.25,
  accelTimeConstant: 0.45,
  maxExtrapolateMs: 1000,
  baselineMs: 2000,
  maxBaselineMs: 12000,
};

export interface SpeedReading {
  speed: number;
  acceleration: number;
  valid: boolean;
  /** Age of the last accepted fix in ms (Infinity when none). */
  ageMs: number;
  lastQuality: FixQuality | 'none';
}

const EARTH_R = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface EstimatorStats {
  /** Average time between fixes, ms (null until two fixes arrived). */
  intervalMs: number | null;
  /** Where the last speed value came from. */
  speedSource: 'device' | 'position' | 'none';
  fixes: number;
}

export class SpeedEstimator {
  private opts: EstimatorOptions;
  private history: GpsFix[] = [];
  private lastFixAt = -Infinity;
  private lastAccepted = -Infinity;
  private speed = 0;
  private accel = 0;
  private hasEstimate = false;
  private lastQuality: FixQuality | 'none' = 'none';
  private interval: number | null = null;
  private source: EstimatorStats['speedSource'] = 'none';
  private fixCount = 0;

  constructor(options: Partial<EstimatorOptions> = {}) {
    this.opts = { ...DEFAULT_ESTIMATOR_OPTIONS, ...options };
  }

  reset(): void {
    this.history = [];
    this.lastFixAt = -Infinity;
    this.lastAccepted = -Infinity;
    this.speed = 0;
    this.accel = 0;
    this.hasEstimate = false;
    this.lastQuality = 'none';
    this.interval = null;
    this.source = 'none';
    this.fixCount = 0;
  }

  get stats(): EstimatorStats {
    return { intervalMs: this.interval, speedSource: this.source, fixes: this.fixCount };
  }

  /**
   * Feed one fix. `timestamp` should be the time the fix was *received* on this
   * device's clock: some browsers report GPS-clock or cached timestamps that
   * drift from the system clock or repeat, which would otherwise make every fix
   * look stale or out of order.
   */
  addFix(fix: GpsFix): FixQuality {
    const o = this.opts;
    const fieldsOk =
      isFiniteNumber(fix.timestamp) &&
      isFiniteNumber(fix.latitude) &&
      isFiniteNumber(fix.longitude) &&
      Math.abs(fix.latitude) <= 90 &&
      Math.abs(fix.longitude) <= 180 &&
      isFiniteNumber(fix.accuracy) &&
      fix.accuracy >= 0;
    if (!fieldsOk) return (this.lastQuality = 'invalid');
    if (fix.timestamp <= this.lastFixAt) return (this.lastQuality = 'invalid');
    if (Number.isFinite(this.lastFixAt)) {
      const gap = fix.timestamp - this.lastFixAt;
      this.interval = this.interval === null ? gap : this.interval * 0.7 + gap * 0.3;
    }
    this.lastFixAt = fix.timestamp;
    this.fixCount++;

    const deviceSpeed = fix.speed !== null && isFiniteNumber(fix.speed) && fix.speed >= 0 ? fix.speed : null;
    const positionUsable = fix.accuracy <= o.maxAccuracyM;
    if (positionUsable) {
      this.history.push(fix);
      const cutoff = fix.timestamp - o.maxBaselineMs;
      while (this.history.length > 1 && this.history[0].timestamp < cutoff) this.history.shift();
    }

    let measured: number | null = null;
    if (deviceSpeed !== null && fix.accuracy <= o.maxAccuracyForSpeedM) {
      measured = deviceSpeed;
      this.source = 'device';
    } else if (positionUsable) {
      // Use a baseline of a couple of seconds: over 1 s, GPS jitter swamps low speeds.
      const ref = this.pickBaseline(fix);
      if (ref) {
        const dt = (fix.timestamp - ref.timestamp) / 1000;
        const d = haversineMeters(ref.latitude, ref.longitude, fix.latitude, fix.longitude);
        // Movement inside the position uncertainty is treated as standing still (parked drift).
        const noise = ((fix.accuracy + ref.accuracy) / 2) * 0.6;
        measured = d <= noise ? 0 : d / dt;
        this.source = 'position';
      }
    } else {
      return (this.lastQuality = 'poor-accuracy');
    }

    if (measured === null) {
      // First usable fix: we know where we are, not yet how fast.
      return (this.lastQuality = 'good');
    }
    if (measured > o.maxSpeedMs) return (this.lastQuality = 'invalid');

    const dt = this.hasEstimate ? clamp((fix.timestamp - this.lastAccepted) / 1000, 0.05, 12) : 0;
    if (!this.hasEstimate) {
      this.speed = measured;
      this.accel = 0;
      this.hasEstimate = true;
    } else {
      // Limit the jump to what a car can physically do, then smooth.
      const maxStep = o.maxAccelMs2 * dt;
      const bounded = clamp(measured, this.speed - maxStep, this.speed + maxStep);
      const prevSpeed = this.speed;
      this.speed = smoothToward(this.speed, bounded, dt, o.speedTimeConstant);
      // Acceleration from the new measurement itself, so braking shows up on the next fix.
      const rawAccel = dt > 0 ? (bounded - prevSpeed) / dt : 0;
      this.accel = smoothToward(this.accel, clamp(rawAccel, -o.maxAccelMs2, o.maxAccelMs2), dt, o.accelTimeConstant);
    }
    this.lastAccepted = fix.timestamp;
    return (this.lastQuality = 'good');
  }

  /** Newest earlier fix at least `baselineMs` old, else the oldest one at least 0.8 s old. */
  private pickBaseline(fix: GpsFix): GpsFix | null {
    const o = this.opts;
    // With a precise fix a 1 s baseline is enough; coarse fixes need longer to beat the jitter.
    const wanted = fix.accuracy <= 12 ? Math.min(1000, o.baselineMs) : o.baselineMs;
    let best: GpsFix | null = null;
    for (let i = this.history.length - 2; i >= 0; i--) {
      const h = this.history[i];
      const age = fix.timestamp - h.timestamp;
      if (age > o.maxBaselineMs) break;
      if (age >= 800) best = h;
      if (age >= wanted) return h;
    }
    return best;
  }

  /** Current estimate at `nowMs` (same clock as fix timestamps). */
  read(nowMs: number): SpeedReading {
    const age = this.hasEstimate ? nowMs - this.lastAccepted : Infinity;
    const valid = this.hasEstimate && age >= -1000 && age <= this.opts.staleMs;
    if (!valid) {
      return { speed: 0, acceleration: 0, valid: false, ageMs: age, lastQuality: this.lastQuality };
    }
    const ahead = clamp(age, 0, this.opts.maxExtrapolateMs) / 1000;
    // Only project braking forward: projecting acceleration made the sound keep
    // climbing for a moment after the driver had already braked.
    const speed = Math.max(0, this.speed + Math.min(0, this.accel) * ahead);
    return { speed, acceleration: this.accel, valid: true, ageMs: age, lastQuality: this.lastQuality };
  }
}
