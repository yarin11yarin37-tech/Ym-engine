import type { VehicleProfile } from './types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Checks a vehicle profile for internally consistent, believable values. */
export function validateProfile(p: VehicleProfile): ValidationResult {
  const errors: string[] = [];
  const err = (m: string) => errors.push(`${p.id || '(no id)'}: ${m}`);

  if (!p.id || !/^[a-z0-9-]+$/.test(p.id)) err('id must be lowercase kebab-case');
  if (!p.displayName?.trim()) err('displayName is required');
  if (![3, 4, 5, 6, 8, 10, 12, 16].includes(p.cylinders)) err(`unsupported cylinder count ${p.cylinders}`);

  const r = p.rpm;
  if (!(r.min >= 0)) err('rpm.min must be ≥ 0');
  if (!(r.idle >= 400 && r.idle <= 1500)) err('rpm.idle should be 400–1500');
  if (!(r.redline > r.idle * 3)) err('rpm.redline must be well above idle');
  if (!(r.limiter >= r.redline)) err('rpm.limiter must be ≥ redline');
  if (!(r.max >= r.limiter)) err('rpm.max must be ≥ limiter');
  if (!(r.max <= 12000)) err('rpm.max should be ≤ 12000');
  if (!(r.launch > r.idle && r.launch < r.redline)) err('rpm.launch must be between idle and redline');

  if (p.gearRatios.length < 4 || p.gearRatios.length > 10) err('need 4–10 gear ratios');
  p.gearRatios.forEach((g, i) => {
    if (!(g > 0.4 && g < 6)) err(`gear ${i + 1} ratio ${g} out of range`);
    if (i > 0 && !(g < p.gearRatios[i - 1])) err(`gear ratios must strictly decrease (gear ${i + 1})`);
  });
  if (!(p.finalDrive > 2 && p.finalDrive < 5.5)) err('finalDrive out of range 2–5.5');
  if (!(p.wheelCircumference > 1.6 && p.wheelCircumference < 2.8)) err('wheelCircumference out of range 1.6–2.8 m');

  const s = p.shift;
  if (!(s.upLight > r.idle * 2 && s.upLight < s.upFull)) err('shift.upLight must sit between 2×idle and upFull');
  if (!(s.upFull <= r.limiter)) err('shift.upFull must be ≤ limiter');
  if (!(s.down > r.idle && s.down * 1.9 < s.upLight * 1.6)) err('shift.down must leave hysteresis below upshift points');
  if (!(s.kickdownMaxRpm < r.redline)) err('shift.kickdownMaxRpm must be below redline');
  if (!(s.durationMs >= 50 && s.durationMs <= 600)) err('shift.durationMs out of range 50–600');
  if (!(s.minDwellMs >= s.durationMs)) err('shift.minDwellMs must be ≥ durationMs');

  const rs = p.response;
  for (const [k, v] of Object.entries({ riseTime: rs.riseTime, fallTime: rs.fallTime, throttleRiseTime: rs.throttleRiseTime })) {
    if (!(v > 0.02 && v < 3)) err(`response.${k} out of range`);
  }
  if (!(rs.throttleCurve > 0.3 && rs.throttleCurve <= 2)) err('response.throttleCurve out of range');
  if (!(rs.zeroToHundred > 1.8 && rs.zeroToHundred < 15)) err('response.zeroToHundred out of range');

  const forced = p.induction !== 'none';
  if (forced && !(p.boost.maxBar > 0)) err('forced induction needs boost.maxBar > 0');
  if (!forced && p.boost.maxBar !== 0) err('naturally aspirated profile must have boost.maxBar = 0');

  const a = p.audio;
  const angles = a.firingBanks.flat();
  if (angles.length !== p.cylinders) err(`firing angles (${angles.length}) must equal cylinders (${p.cylinders})`);
  if (angles.some((x) => !(x >= 0 && x < 720))) err('firing angles must be within 0–720°');
  if (new Set(angles).size !== angles.length) err('firing angles must be unique');
  if (a.bankGains.length !== a.firingBanks.length) err('bankGains must match firingBanks');
  if (a.resonators.length < 1 || a.resonators.length > 4) err('need 1–4 resonators');
  a.resonators.forEach((res, i) => {
    if (!(res.freq > 20 && res.freq < 8000)) err(`resonator ${i} freq out of range`);
    if (!(res.q > 0.3 && res.q < 30)) err(`resonator ${i} q out of range`);
  });
  if (a.harmonics.length > 4) err('at most 4 harmonic layers (CPU budget)');
  if (!(a.crackle >= 0 && a.crackle <= 1)) err('audio.crackle must be 0–1');
  if (forced && !(a.induction.whineLevel > 0 || a.induction.hissLevel > 0)) err('forced induction needs an induction voice');

  if (!HEX.test(p.ui.accent)) err('ui.accent must be a #rrggbb colour');

  return { valid: errors.length === 0, errors };
}

export function validateAll(profiles: VehicleProfile[]): ValidationResult {
  const errors = profiles.flatMap((p) => validateProfile(p).errors);
  const ids = profiles.map((p) => p.id);
  if (new Set(ids).size !== ids.length) errors.push('duplicate vehicle ids');
  return { valid: errors.length === 0, errors };
}
