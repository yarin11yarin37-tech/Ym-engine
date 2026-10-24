import { rpmFromSpeed } from './drivetrain';
import type { VehicleProfile } from './types';
import { lerp } from '../utils/math';

export interface ShiftDecisionInput {
  gear: number;
  rpm: number;
  speed: number;
  throttle: number;
  /** Throttle rate of change per second (positive = pressing). */
  throttleRate: number;
  /** Milliseconds since the last completed shift. */
  sinceLastShiftMs: number;
  shifting: boolean;
}

/** Upshift point for the current throttle (light → early, full → near redline). */
export function upshiftRpm(profile: VehicleProfile, throttle: number): number {
  const t = Math.pow(Math.min(1, Math.max(0, throttle)), 1.4);
  return lerp(profile.shift.upLight, profile.shift.upFull, t);
}

/**
 * Downshift threshold. Rises with throttle so a loaded engine is kept in its
 * power band, but always stays well below the upshift point of the gear below
 * (hysteresis) so the box never hunts.
 */
export function downshiftRpm(profile: VehicleProfile, throttle: number): number {
  return lerp(profile.shift.down, profile.shift.down * 1.9, Math.min(1, Math.max(0, throttle)));
}

/**
 * Automatic gear decision. Returns the new target gear or `null` to hold.
 * Rules: dwell time between shifts, no decisions mid-shift, hysteresis between
 * up and down thresholds, kickdown on a fast, deep pedal press.
 */
export function decideAutoShift(profile: VehicleProfile, input: ShiftDecisionInput): number | null {
  const { gear, speed, throttle, throttleRate, sinceLastShiftMs, shifting } = input;
  const gears = profile.gearRatios.length;
  if (shifting) return null;

  // Kickdown: deep, fast press while the lower gear would stay safely under redline.
  const kickdown = throttle > 0.85 && throttleRate > 1.5;
  if (kickdown && gear > 1 && sinceLastShiftMs > profile.shift.minDwellMs * 0.4) {
    let target = gear;
    while (target > 1 && rpmFromSpeed(profile, speed, target - 1) < profile.shift.kickdownMaxRpm) target--;
    if (target < gear) return target;
  }

  if (sinceLastShiftMs < profile.shift.minDwellMs) return null;

  const rpm = Math.max(input.rpm, rpmFromSpeed(profile, speed, gear));
  if (gear < gears && rpm >= upshiftRpm(profile, throttle)) {
    // Only upshift if the next gear will not immediately fall below the downshift line.
    const nextRpm = rpmFromSpeed(profile, speed, gear + 1);
    if (nextRpm > downshiftRpm(profile, throttle) * 1.08 || rpm >= profile.rpm.redline) return gear + 1;
  }

  if (gear > 1) {
    const wheelRpm = rpmFromSpeed(profile, speed, gear);
    if (wheelRpm < downshiftRpm(profile, throttle)) {
      const lowerRpm = rpmFromSpeed(profile, speed, gear - 1);
      // Never downshift into an over-rev.
      if (lowerRpm < profile.rpm.redline * 0.92) return gear - 1;
    }
  }
  return null;
}

/** Manual downshift is refused when it would over-rev the engine. */
export function isManualDownshiftSafe(profile: VehicleProfile, speed: number, targetGear: number): boolean {
  if (targetGear < 1) return false;
  return rpmFromSpeed(profile, speed, targetGear) < profile.rpm.limiter * 0.98;
}
