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
  maxAccuracyM: number;
  staleMs: number;
  maxSpeedMs: number;
  maxAccelMs2: number;
  speedTimeConstant: number;
  accelTimeConstant: number;
  maxExtrapolateMs: number;
}

export const DEFAULT_ESTIMATOR_OPTIONS: EstimatorOptions = {
  maxAccuracyM: 35,
  staleMs: 4500,
  maxSpeedMs: 95, // ~340 km/h — anything above is a glitch
  maxAccelMs2: 12,
  speedTimeConstant: 0.9,
  accelTimeConstant: 1.2,
  maxExtrapolateMs: 1500,
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

export class SpeedEstimator {
  private opts: EstimatorOptions;
  private prevFix: GpsFix | null = null;
  private lastAccepted = -Infinity;
  private speed = 0;
  private accel = 0;
  private hasEstimate = false;
  private lastQuality: FixQuality | 'none' = 'none';

  constructor(options: Partial<EstimatorOptions> = {}) {
    this.opts = { ...DEFAULT_ESTIMATOR_OPTIONS, ...options };
  }

  reset(): void {
    this.prevFix = null;
    this.lastAccepted = -Infinity;
    this.speed = 0;
    this.accel = 0;
    this.hasEstimate = false;
    this.lastQuality = 'none';
  }

  /** Feed one fix. Returns how it was classified. */
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
    if (this.prevFix && fix.timestamp <= this.prevFix.timestamp) return (this.lastQuality = 'invalid');
    if (fix.accuracy > o.maxAccuracyM) {
      // Keep the fix for distance continuity only if nothing better exists.
      return (this.lastQuality = 'poor-accuracy');
    }

    let measured: number | null = null;
    if (fix.speed !== null && isFiniteNumber(fix.speed) && fix.speed >= 0) {
      measured = fix.speed;
    } else if (this.prevFix) {
      const dt = (fix.timestamp - this.prevFix.timestamp) / 1000;
      if (dt >= 0.4 && dt <= 5) {
        const d = haversineMeters(this.prevFix.latitude, this.prevFix.longitude, fix.latitude, fix.longitude);
        // Ignore movement smaller than the combined position uncertainty (GPS drift while parked).
        const noise = Math.max(fix.accuracy, this.prevFix.accuracy) * 0.5;
        measured = d <= noise ? 0 : d / dt;
      }
    }
    this.prevFix = fix;
    if (measured === null) {
      this.lastAccepted = fix.timestamp;
      return (this.lastQuality = 'good');
    }
    if (measured > o.maxSpeedMs) return (this.lastQuality = 'invalid');

    const dt = this.hasEstimate ? clamp((fix.timestamp - this.lastAccepted) / 1000, 0.05, 5) : 0;
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
      const rawAccel = dt > 0 ? (this.speed - prevSpeed) / dt : 0;
      this.accel = smoothToward(this.accel, clamp(rawAccel, -o.maxAccelMs2, o.maxAccelMs2), dt, o.accelTimeConstant);
    }
    this.lastAccepted = fix.timestamp;
    return (this.lastQuality = 'good');
  }

  /** Current estimate at `nowMs` (same clock as fix timestamps). */
  read(nowMs: number): SpeedReading {
    const age = this.hasEstimate ? nowMs - this.lastAccepted : Infinity;
    const valid = this.hasEstimate && age >= -1000 && age <= this.opts.staleMs;
    if (!valid) {
      return { speed: 0, acceleration: 0, valid: false, ageMs: age, lastQuality: this.lastQuality };
    }
    const ahead = clamp(age, 0, this.opts.maxExtrapolateMs) / 1000;
    const speed = Math.max(0, this.speed + this.accel * ahead);
    return { speed, acceleration: this.accel, valid: true, ageMs: age, lastQuality: this.lastQuality };
  }
}
