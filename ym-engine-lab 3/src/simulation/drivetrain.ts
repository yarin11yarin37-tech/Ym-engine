import type { VehicleProfile } from './types';

/** Engine RPM for a vehicle speed (m/s) in a given gear (1-based), with no clutch slip. */
export function rpmFromSpeed(profile: VehicleProfile, speedMs: number, gear: number): number {
  const ratio = profile.gearRatios[gear - 1];
  if (ratio === undefined || speedMs <= 0) return 0;
  const wheelRps = speedMs / profile.wheelCircumference;
  return wheelRps * ratio * profile.finalDrive * 60;
}

/** Vehicle speed (m/s) at an engine RPM in a given gear. */
export function speedFromRpm(profile: VehicleProfile, rpm: number, gear: number): number {
  const ratio = profile.gearRatios[gear - 1];
  if (ratio === undefined || rpm <= 0) return 0;
  return (rpm / 60 / (ratio * profile.finalDrive)) * profile.wheelCircumference;
}

/** Normalised torque curve (0..1) — broad plateau, softer at idle, falling past peak power. */
export function torqueCurve(profile: VehicleProfile, rpm: number): number {
  const { idle, limiter } = profile.rpm;
  const x = Math.min(1.1, Math.max(0, (rpm - idle) / (limiter - idle)));
  const forced = profile.induction !== 'none';
  // Forced-induction engines reach the plateau earlier; NA engines build toward the top.
  const peak = forced ? 0.35 : 0.68;
  const rise = forced ? 0.55 + 0.45 * Math.min(1, x / peak) : 0.5 + 0.5 * Math.min(1, x / peak);
  const fall = x > 0.85 ? 1 - (x - 0.85) * 1.2 : 1;
  return Math.max(0.1, rise * fall);
}

/**
 * Engine RPM when the clutch / converter is slipping at very low speed:
 * the engine stays near idle and flares with throttle until the wheels catch up.
 */
export function coupledRpm(profile: VehicleProfile, speedMs: number, gear: number, throttle: number): number {
  const wheelRpm = rpmFromSpeed(profile, speedMs, gear);
  const slipRpm = profile.rpm.idle + throttle * (profile.rpm.launch * 0.8 - profile.rpm.idle);
  return Math.max(wheelRpm, gear === 1 ? slipRpm : profile.rpm.idle);
}
