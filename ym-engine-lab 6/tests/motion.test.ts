import { describe, expect, it } from 'vitest';
import { MotionSensor, type Vec3 } from '../src/features/driving-mode/motionSensor';
import { SpeedFusion } from '../src/features/driving-mode/speedFusion';
import { EngineSimulator } from '../src/simulation/EngineSimulator';
import { getVehicle } from '../src/data/vehicles';

const G = 9.81;
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

interface Mount {
  up: Vec3; // device-frame direction of "up"
  forward: Vec3; // device-frame direction of the car's nose
  flip?: boolean; // browser reports inverted signs
  noLinear?: boolean; // browser gives only acceleration-including-gravity
}

/** Drives a sensor through a scripted car acceleration profile. */
function rig(mount: Mount) {
  let now = 0;
  const sensor = new MotionSensor(() => now);
  const up = norm(mount.up);
  const fwd = norm(mount.forward);
  const left = cross(up, fwd);
  const k = mount.flip ? -1 : 1;
  const sample = (along: number, lateral = 0) => {
    const lin: Vec3 = [0, 1, 2].map((i) => fwd[i] * along + left[i] * lateral) as Vec3;
    const wg: Vec3 = [0, 1, 2].map((i) => (up[i] * G + lin[i]) * k) as Vec3;
    sensor.ingest({ withGravity: wg, linear: mount.noLinear ? null : (lin.map((x) => x * k) as Vec3) }, now);
  };
  /** Runs `seconds` at 60 Hz; GPS acceleration lags the true value by 0.7 s. */
  const run = (seconds: number, accel: (t: number) => number, opts: { lateral?: number; learn?: boolean } = {}) => {
    const start = now;
    for (let t = 0; t < seconds; t += 1 / 60) {
      now = start + t * 1000;
      sample(accel(t), opts.lateral ?? 0);
      if (opts.learn !== false) sensor.learn(accel(Math.max(0, t - 0.7)), 1 / 60);
    }
  };
  const teach = () => {
    run(3, () => 2.5);
    run(2, () => 0);
    run(2, () => -3);
    run(1, () => 0);
  };
  return { sensor, run, teach };
}

const upright: Mount = { up: [0, 1, 0], forward: [0, 0, -1] };
const tilted: Mount = { up: [0.3, 0.8, 0.52], forward: cross([0.3, 0.8, 0.52], [1, 0, 0]) };

describe('Motion sensor — learning how the phone is mounted', () => {
  it('stays in "learning" (unused) until GPS has confirmed the direction', () => {
    const r = rig(upright);
    r.run(1, () => 0, { learn: false });
    expect(r.sensor.status).toBe('learning');
    expect(r.sensor.usable).toBe(false);
  });

  for (const [name, mount] of [
    ['upright mount', upright],
    ['tilted, rotated mount', tilted],
    ['browser with inverted axis signs', { ...upright, flip: true }],
    ['browser without separate gravity data', { ...tilted, noLinear: true }],
  ] as [string, Mount][]) {
    it(`learns forward and reports braking instantly — ${name}`, () => {
      const r = rig(mount);
      r.teach();
      expect(r.sensor.status).toBe('active');
      expect(r.sensor.usable).toBe(true);
      // Sudden hard braking: within 0.25 s the sensor should already show it.
      r.run(0.25, () => -4, { learn: false });
      expect(r.sensor.acceleration).toBeLessThan(-3);
      r.run(0.5, () => 3, { learn: false });
      expect(r.sensor.acceleration).toBeGreaterThan(2.2);
    });
  }

  it('cornering (sideways force) is not mistaken for throttle or braking', () => {
    const r = rig(tilted);
    r.teach();
    r.run(1.5, () => 0, { lateral: 3, learn: false });
    expect(Math.abs(r.sensor.acceleration)).toBeLessThan(0.6);
  });

  it('recalibrate forgets the direction', () => {
    const r = rig(upright);
    r.teach();
    r.sensor.recalibrate();
    expect(r.sensor.usable).toBe(false);
    expect(r.sensor.confidence).toBe(0);
  });
});

describe('Speed fusion', () => {
  const gps = (speed: number, acceleration = 0, valid = true) => ({ speed, acceleration, valid, ageMs: 100, lastQuality: 'good' as const });

  it('passes GPS through without a motion sensor', () => {
    const f = new SpeedFusion();
    expect(f.update(0.016, gps(20, 1), null)).toEqual({ speed: 20, acceleration: 1, valid: true });
  });

  it('reacts to the motion sensor before GPS does', () => {
    const f = new SpeedFusion();
    f.update(0.016, gps(20), 0);
    let out = f.update(0.016, gps(20), -6);
    for (let i = 0; i < 30; i++) out = f.update(1 / 60, gps(20), -6);
    expect(out.acceleration).toBe(-6);
    expect(out.speed).toBeLessThan(18);
  });

  it('is pulled back to GPS so it cannot drift away', () => {
    const f = new SpeedFusion();
    f.update(0.016, gps(20), 0);
    let out = f.update(0.016, gps(20), 0.5); // small sensor bias
    for (let i = 0; i < 60 * 20; i++) out = f.update(1 / 60, gps(20), 0.5);
    expect(Math.abs(out.speed - 20)).toBeLessThan(1);
  });

  it('never invents motion when GPS is invalid', () => {
    const f = new SpeedFusion();
    expect(f.update(0.016, gps(0, 0, false), -3).valid).toBe(false);
  });
});

describe('Driving mode with motion sensor', () => {
  it('drops the throttle sound within 0.3 s of braking', () => {
    const m5 = getVehicle('bmw-m5-competition');
    const sim = new EngineSimulator(m5);
    sim.start();
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    sim.setMode('driving');
    const f = new SpeedFusion();
    const step = (accel: number, n: number) => {
      for (let i = 0; i < n; i++) {
        sim.setSpeedEstimate(f.update(1 / 60, { speed: 22, acceleration: 0, valid: true, ageMs: 100, lastQuality: 'good' }, accel));
        sim.step(1 / 60);
      }
    };
    step(2.5, 180); // accelerating: engine under load
    expect(sim.state.throttle).toBeGreaterThan(0.2);
    step(-5, 18); // 0.3 s of hard braking
    expect(sim.state.throttle).toBeLessThan(0.08);
  });
});
