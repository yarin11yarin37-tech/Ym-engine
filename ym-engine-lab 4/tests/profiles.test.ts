import { describe, expect, it } from 'vitest';
import { VEHICLES, getVehicle } from '../src/data/vehicles';
import { validateAll, validateProfile } from '../src/simulation/validateProfile';
import { flattenFiring } from '../src/simulation/firing';
import { rpmCrossfadeWeights } from '../src/features/audio/assetManifest';

describe('Vehicle profile validation', () => {
  it('all shipped profiles are valid', () => {
    const r = validateAll(VEHICLES);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('ships the eight required profiles', () => {
    expect(VEHICLES).toHaveLength(8);
    const names = VEHICLES.map((v) => v.displayName).join('|');
    for (const n of ['M5', 'AMG GT', 'Huracán', 'V12', 'GT-R', 'Supra', 'Hellcat', '911 GT3']) expect(names).toContain(n);
  });

  it('catches inconsistent values', () => {
    const bad = structuredClone(getVehicle('bmw-m5-competition'));
    bad.gearRatios = [3, 3.5, 2];
    bad.rpm.limiter = 5000;
    bad.audio.firingBanks = [[0, 90]];
    bad.ui.accent = 'blue';
    const r = validateProfile(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('gear ratios'))).toBe(true);
    expect(r.errors.some((e) => e.includes('limiter'))).toBe(true);
    expect(r.errors.some((e) => e.includes('firing angles'))).toBe(true);
    expect(r.errors.some((e) => e.includes('accent'))).toBe(true);
  });

  it('flags boost on a naturally aspirated engine', () => {
    const bad = structuredClone(getVehicle('porsche-911-gt3'));
    bad.boost.maxBar = 1;
    expect(validateProfile(bad).valid).toBe(false);
  });

  it('detects duplicate ids', () => {
    expect(validateAll([VEHICLES[0], VEHICLES[0]]).valid).toBe(false);
  });

  it('profiles sound different (distinct firing and resonance)', () => {
    const sigs = VEHICLES.map((v) => JSON.stringify([v.cylinders, v.audio.firingBanks, v.audio.resonators.map((r) => r.freq)]));
    expect(new Set(sigs).size).toBe(VEHICLES.length);
  });

  it('firing events are sorted and tagged with a bank', () => {
    const ev = flattenFiring(getVehicle('dodge-challenger-hellcat').audio.firingBanks);
    expect(ev).toHaveLength(8);
    for (let i = 1; i < ev.length; i++) expect(ev[i].angle).toBeGreaterThan(ev[i - 1].angle);
    expect(new Set(ev.map((e) => e.bank)).size).toBe(2);
  });

  it('unknown vehicle ids fall back to the first profile', () => {
    expect(getVehicle('nope').id).toBe(VEHICLES[0].id);
  });
});

describe('Recorded-layer crossfade', () => {
  const pts = [1000, 3000, 5000];
  it('is equal-power between neighbours', () => {
    const w = rpmCrossfadeWeights(pts, 2000);
    expect(w[0] ** 2 + w[1] ** 2).toBeCloseTo(1, 6);
    expect(w[2]).toBe(0);
  });
  it('clamps at the ends', () => {
    expect(rpmCrossfadeWeights(pts, 500)).toEqual([1, 0, 0]);
    expect(rpmCrossfadeWeights(pts, 9000)).toEqual([0, 0, 1]);
  });
  it('handles an empty list', () => {
    expect(rpmCrossfadeWeights([], 2000)).toEqual([]);
  });
});
