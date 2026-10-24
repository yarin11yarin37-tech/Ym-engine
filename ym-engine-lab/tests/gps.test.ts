import { describe, expect, it } from 'vitest';
import { SpeedEstimator, haversineMeters, type GpsFix } from '../src/features/driving-mode/speedEstimator';
import { GpsTracker, type GeolocationLike } from '../src/features/driving-mode/gpsTracker';

const fix = (t: number, speed: number | null, extra: Partial<GpsFix> = {}): GpsFix => ({
  timestamp: t,
  latitude: 32.08,
  longitude: 34.78,
  accuracy: 8,
  speed,
  ...extra,
});

describe('Speed estimator — stale data', () => {
  it('is invalid before any fix', () => {
    const e = new SpeedEstimator();
    expect(e.read(1000).valid).toBe(false);
  });

  it('becomes stale after staleMs without a fix', () => {
    const e = new SpeedEstimator({ staleMs: 3000 });
    e.addFix(fix(1000, 20));
    expect(e.read(2000).valid).toBe(true);
    expect(e.read(3900).valid).toBe(true);
    const r = e.read(4100);
    expect(r.valid).toBe(false);
    expect(r.speed).toBe(0);
  });

  it('recovers once fresh fixes arrive', () => {
    const e = new SpeedEstimator({ staleMs: 3000 });
    e.addFix(fix(1000, 20));
    expect(e.read(9000).valid).toBe(false);
    e.addFix(fix(9500, 21));
    expect(e.read(9600).valid).toBe(true);
  });

  it('dead-reckons for a limited time only', () => {
    const e = new SpeedEstimator({ maxExtrapolateMs: 1000, staleMs: 5000 });
    for (let i = 0; i < 10; i++) e.addFix(fix(1000 + i * 1000, 10 + i));
    const a = e.read(10_000 + 1000).speed;
    const b = e.read(10_000 + 3000).speed;
    expect(b).toBeCloseTo(a, 6);
  });
});

describe('Speed estimator — invalid sensor values', () => {
  it('rejects NaN, infinite and out-of-range fields', () => {
    const e = new SpeedEstimator();
    expect(e.addFix(fix(1000, 10, { latitude: Number.NaN }))).toBe('invalid');
    expect(e.addFix(fix(1000, 10, { longitude: 500 }))).toBe('invalid');
    expect(e.addFix(fix(1000, 10, { accuracy: Number.POSITIVE_INFINITY }))).toBe('invalid');
    expect(e.addFix(fix(Number.NaN, 10))).toBe('invalid');
    expect(e.read(1000).valid).toBe(false);
  });

  it('rejects implausible speeds', () => {
    const e = new SpeedEstimator();
    expect(e.addFix(fix(1000, 400))).toBe('invalid');
    expect(e.read(1000).valid).toBe(false);
  });

  it('ignores negative / non-finite device speed and falls back to positions', () => {
    const e = new SpeedEstimator();
    e.addFix(fix(1000, -1));
    // ~27.8 m north in 1 s ≈ 100 km/h
    const q = e.addFix(fix(2000, Number.NaN, { latitude: 32.08 + 27.8 / 111_195 }));
    expect(q).toBe('good');
    expect(e.read(2000).speed).toBeGreaterThan(25);
  });

  it('flags poor accuracy and does not let it move the estimate', () => {
    const e = new SpeedEstimator({ maxAccuracyM: 30 });
    e.addFix(fix(1000, 10));
    expect(e.addFix(fix(2000, 40, { accuracy: 300 }))).toBe('poor-accuracy');
    expect(e.read(2000).speed).toBeLessThan(11);
  });

  it('rejects out-of-order timestamps', () => {
    const e = new SpeedEstimator();
    e.addFix(fix(5000, 10));
    expect(e.addFix(fix(4000, 30))).toBe('invalid');
  });

  it('treats sub-noise movement as stationary (parked GPS drift)', () => {
    const e = new SpeedEstimator();
    e.addFix(fix(1000, null, { accuracy: 20 }));
    e.addFix(fix(2000, null, { accuracy: 20, latitude: 32.08 + 5 / 111_195 }));
    expect(e.read(2000).speed).toBe(0);
  });

  it('limits physically impossible jumps and smooths', () => {
    const e = new SpeedEstimator();
    e.addFix(fix(1000, 10));
    e.addFix(fix(2000, 60));
    const s = e.read(2000).speed;
    expect(s).toBeGreaterThan(10);
    expect(s).toBeLessThan(10 + 12);
  });
});

describe('Speed estimator — real car browser conditions', () => {
  const north = (m: number) => 32.08 + m / 111_195;

  it('trusts device-reported speed even when the position radius is coarse', () => {
    const e = new SpeedEstimator();
    e.addFix(fix(1000, 20, { accuracy: 90 }));
    expect(e.read(1500).valid).toBe(true);
    expect(e.read(1500).speed).toBeCloseTo(20, 3);
    expect(e.stats.speedSource).toBe('device');
  });

  it('measures city speed from positions at 1 Hz with ±15 m accuracy', () => {
    const e = new SpeedEstimator();
    const v = 30 / 3.6; // 30 km/h
    for (let i = 0; i <= 8; i++) e.addFix(fix(1000 + i * 1000, null, { accuracy: 15, latitude: north(v * i) }));
    const r = e.read(9000);
    expect(r.valid).toBe(true);
    expect(r.speed * 3.6).toBeGreaterThan(20);
    expect(r.speed * 3.6).toBeLessThan(40);
    expect(e.stats.speedSource).toBe('position');
  });

  it('keeps working when the browser only updates every 5 s', () => {
    const e = new SpeedEstimator();
    const v = 20;
    for (let i = 0; i <= 4; i++) e.addFix(fix(1000 + i * 5000, null, { latitude: north(v * i * 5) }));
    const r = e.read(21_000 + 4000);
    expect(r.valid).toBe(true);
    expect(r.speed).toBeGreaterThan(15);
    expect(e.stats.intervalMs).toBeCloseTo(5000, 0);
  });
});

describe('Haversine', () => {
  it('measures one degree of latitude as ~111 km', () => {
    expect(haversineMeters(0, 0, 1, 0)).toBeGreaterThan(111_000);
    expect(haversineMeters(0, 0, 1, 0)).toBeLessThan(111_400);
  });
});

describe('GPS tracker lifecycle', () => {
  function fakeGeo() {
    let success: ((p: GeolocationPosition) => void) | null = null;
    let error: ((e: GeolocationPositionError) => void) | null = null;
    const cleared: number[] = [];
    const geo: GeolocationLike = {
      watchPosition(s, e) {
        success = s;
        error = e ?? null;
        return 42;
      },
      clearWatch(id) {
        cleared.push(id);
      },
    };
    const pos = (t: number, speed: number, accuracy = 5) =>
      ({ timestamp: t, coords: { latitude: 32, longitude: 34, accuracy, speed } }) as unknown as GeolocationPosition;
    return { geo, cleared, emit: (t: number, s: number, a?: number) => success?.(pos(t, s, a)), fail: (code: number) => error?.({ code } as GeolocationPositionError) };
  }

  it('reports unsupported and insecure contexts', () => {
    const a = new GpsTracker(undefined, true);
    a.start();
    expect(a.status).toBe('unsupported');
    const b = new GpsTracker(fakeGeo().geo, false);
    b.start();
    expect(b.status).toBe('insecure-context');
  });

  it('moves through awaiting → connected → lost and clears the watcher on stop', () => {
    let now = 1000;
    const f = fakeGeo();
    const t = new GpsTracker(f.geo, true, () => now);
    t.start();
    expect(t.status).toBe('awaiting-permission');
    f.emit(1000, 15);
    expect(t.status).toBe('connected');
    expect(t.read().valid).toBe(true);
    now = 12_000;
    t.read();
    expect(t.status).toBe('lost');
    t.stop();
    expect(f.cleared).toContain(42);
    expect(t.status).toBe('inactive');
  });

  it('handles permission denial', () => {
    const f = fakeGeo();
    const t = new GpsTracker(f.geo, true);
    t.start();
    f.fail(1);
    expect(t.status).toBe('denied');
    expect(f.cleared).toContain(42);
  });

  it('reports poor accuracy', () => {
    const f = fakeGeo();
    const t = new GpsTracker(f.geo, true, () => 1000);
    t.start();
    f.emit(1000, Number.NaN, 400);
    expect(t.status).toBe('poor-accuracy');
  });

  it('falls back to low accuracy after high-accuracy requests keep failing', () => {
    const opts: PositionOptions[] = [];
    let err: ((e: GeolocationPositionError) => void) | undefined;
    let ok: ((p: GeolocationPosition) => void) | undefined;
    const geo: GeolocationLike = {
      watchPosition(s, e, o) {
        ok = s;
        err = e;
        opts.push(o ?? {});
        return opts.length;
      },
      clearWatch() {},
    };
    const t = new GpsTracker(geo, true, () => 1000, false);
    t.start();
    err?.({ code: 2, message: 'unavailable' } as GeolocationPositionError);
    err?.({ code: 3, message: 'timeout' } as GeolocationPositionError);
    expect(t.status).toBe('acquiring');
    expect(t.lowAccuracyMode).toBe(true);
    expect(opts[opts.length - 1].enableHighAccuracy).toBe(false);
    expect(t.lastError).toContain('timeout');
    ok?.({ timestamp: 0, coords: { latitude: 32, longitude: 34, accuracy: 30, speed: 10 } } as unknown as GeolocationPosition);
    expect(t.status).toBe('connected');
  });

  it('gets positions by polling when watchPosition never fires', () => {
    const geo: GeolocationLike = {
      watchPosition: () => 7,
      clearWatch() {},
      getCurrentPosition(s) {
        s({ timestamp: 0, coords: { latitude: 32, longitude: 34, accuracy: 10, speed: 15 } } as unknown as GeolocationPosition);
      },
    };
    const t = new GpsTracker(geo, true, () => 5000, true);
    t.start();
    expect(t.status).toBe('connected');
    expect(t.read().valid).toBe(true);
    t.stop();
  });

  it('ignores the browser timestamp: drifted or repeated GPS clocks still count as fresh', () => {
    let now = 50_000;
    const f = fakeGeo();
    const t = new GpsTracker(f.geo, true, () => now);
    t.start();
    // Browser reports a timestamp from an hour ago, then repeats it.
    f.emit(now - 3_600_000, 12);
    now += 1000;
    f.emit(now - 3_600_000 - 1000, 13);
    expect(t.read().valid).toBe(true);
    expect(t.status).toBe('connected');
  });

  it('does not flag "lost" while waiting for the second fix', () => {
    let now = 1000;
    const f = fakeGeo();
    const t = new GpsTracker(f.geo, true, () => now);
    t.start();
    f.emit(now, Number.NaN);
    now += 500;
    t.read();
    expect(t.status).toBe('connected');
  });
});
