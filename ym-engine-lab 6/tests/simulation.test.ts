import { describe, expect, it } from 'vitest';
import { EngineSimulator } from '../src/simulation/EngineSimulator';
import { rpmFromSpeed, speedFromRpm } from '../src/simulation/drivetrain';
import { decideAutoShift, downshiftRpm, isManualDownshiftSafe, upshiftRpm } from '../src/simulation/gearbox';
import { ThrottleInput, stepThrottle } from '../src/simulation/throttleInput';
import { getVehicle, VEHICLES } from '../src/data/vehicles';
import { smoothToward } from '../src/utils/math';
import { SpeedEstimator } from '../src/features/driving-mode/speedEstimator';
import { kmhToMs } from '../src/utils/math';

const m5 = getVehicle('bmw-m5-competition');
const FRAME = 1 / 60;

function run(sim: EngineSimulator, seconds: number, each?: (t: number) => void) {
  for (let t = 0; t < seconds; t += FRAME) {
    each?.(t);
    sim.step(FRAME);
  }
}

function runningSim(profile = m5) {
  const sim = new EngineSimulator(profile);
  sim.start();
  run(sim, 2);
  return sim;
}

describe('RPM smoothing', () => {
  it('approaches the target exponentially and is frame-rate independent', () => {
    let a = 1000;
    for (let i = 0; i < 60; i++) a = smoothToward(a, 5000, 1 / 60, 0.2);
    let b = 1000;
    for (let i = 0; i < 120; i++) b = smoothToward(b, 5000, 1 / 120, 0.2);
    expect(Math.abs(a - b)).toBeLessThan(1);
    // after 1 s with tc 0.2 s, ~99.3 % of the way there
    expect(a).toBeGreaterThan(4950);
  });

  it('never overshoots', () => {
    let v = 0;
    for (let i = 0; i < 1000; i++) {
      v = smoothToward(v, 100, 0.05, 0.01);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('settles to idle after start without wild oscillation', () => {
    const sim = runningSim();
    expect(sim.state.status).toBe('running');
    run(sim, 3);
    expect(Math.abs(sim.state.rpm - m5.rpm.idle)).toBeLessThan(40);
  });
});

describe('Throttle response', () => {
  it('ramps up progressively while held', () => {
    let t = 0;
    t = stepThrottle(t, 1, 0.1, 0.5);
    expect(t).toBeCloseTo(0.2, 5);
    for (let i = 0; i < 10; i++) t = stepThrottle(t, 1, 0.1, 0.5);
    expect(t).toBe(1);
  });

  it('falls almost immediately on release', () => {
    expect(stepThrottle(1, 0, 0.05, 0.5)).toBeLessThan(0.2);
    expect(stepThrottle(1, 0, 0.1, 0.5)).toBe(0);
  });

  it('raises RPM toward the limiter when revving in neutral', () => {
    const sim = runningSim();
    sim.setDemoDrive('neutral');
    sim.input.press('test');
    run(sim, 1.5);
    expect(sim.state.rpm).toBeGreaterThan(m5.rpm.redline * 0.9);
    expect(sim.state.rpm).toBeLessThanOrEqual(m5.rpm.max);
  });

  it('bounces off the rev limiter instead of exceeding it', () => {
    const sim = runningSim();
    sim.setDemoDrive('neutral');
    sim.input.press('test');
    let cuts = 0;
    let maxRpm = 0;
    run(sim, 3, () => {
      if (sim.state.limiterActive) cuts++;
      maxRpm = Math.max(maxRpm, sim.state.rpm);
    });
    expect(cuts).toBeGreaterThan(0);
    expect(maxRpm).toBeLessThan(m5.rpm.limiter * 1.03);
  });
});

describe('Accelerator release behavior', () => {
  it('requires every source to release', () => {
    const input = new ThrottleInput();
    input.press('pointer:1');
    input.press('key:Space');
    input.release('pointer:1');
    expect(input.target).toBe(1);
    input.release('key:Space');
    expect(input.target).toBe(0);
  });

  it('releaseAll clears stuck sources and scripted overrides', () => {
    const input = new ThrottleInput();
    input.press('pointer:7');
    input.setOverride(0.6);
    input.releaseAll();
    expect(input.pressed).toBe(false);
    expect(input.target).toBe(0);
  });

  it('releasing unknown or duplicate ids is harmless', () => {
    const input = new ThrottleInput();
    input.release('nope');
    input.press('a');
    input.press('a');
    input.release('a');
    expect(input.target).toBe(0);
  });

  it('RPM falls back to idle after the simulator releases throttle (blur / hidden tab)', () => {
    const sim = runningSim();
    sim.setDemoDrive('neutral');
    sim.input.press('pointer:1');
    run(sim, 1);
    expect(sim.state.rpm).toBeGreaterThan(4000);
    sim.releaseThrottle();
    run(sim, 3);
    expect(sim.state.throttle).toBe(0);
    expect(sim.state.rpm).toBeLessThan(m5.rpm.idle + 60);
  });

  it('ignores the pedal while the engine is off', () => {
    const sim = new EngineSimulator(m5);
    sim.input.press('p');
    run(sim, 1);
    expect(sim.state.throttle).toBe(0);
    expect(sim.state.rpm).toBe(0);
  });

  it('a huge frame gap (tab switch) is clamped', () => {
    const sim = runningSim();
    sim.input.press('p');
    sim.step(30);
    expect(sim.state.speed).toBeLessThan(2);
  });
});

describe('Gear-ratio RPM calculations', () => {
  it('converts speed to RPM and back', () => {
    for (const v of VEHICLES) {
      for (let g = 1; g <= v.gearRatios.length; g++) {
        const rpm = rpmFromSpeed(v, kmhToMs(100), g);
        expect(speedFromRpm(v, rpm, g)).toBeCloseTo(kmhToMs(100), 6);
      }
    }
  });

  it('matches the hand calculation', () => {
    // 100 km/h = 27.78 m/s; / 2.2 m = 12.626 rps; × 1.0 × 3.154 × 60 = 2389 rpm in 6th
    expect(rpmFromSpeed(m5, kmhToMs(100), 6)).toBeCloseTo(2389.4, 0);
  });

  it('every profile reaches a plausible speed at redline in first gear', () => {
    for (const v of VEHICLES) {
      const kmh = speedFromRpm(v, v.rpm.redline, 1) * 3.6;
      expect(kmh).toBeGreaterThan(40);
      expect(kmh).toBeLessThan(120);
    }
  });

  it('returns 0 for invalid gears and non-positive speed', () => {
    expect(rpmFromSpeed(m5, 20, 0)).toBe(0);
    expect(rpmFromSpeed(m5, 20, 99)).toBe(0);
    expect(rpmFromSpeed(m5, -5, 2)).toBe(0);
  });
});

describe('Automatic shifting', () => {
  const base = { rpm: 0, throttle: 0.3, throttleRate: 0, sinceLastShiftMs: 5000, shifting: false };

  it('upshifts once RPM passes the throttle-dependent point', () => {
    const speed = speedFromRpm(m5, upshiftRpm(m5, 0.3) + 50, 2);
    expect(decideAutoShift(m5, { ...base, gear: 2, speed })).toBe(3);
  });

  it('holds while RPM is between the shift lines (hysteresis)', () => {
    const mid = (downshiftRpm(m5, 0.3) + upshiftRpm(m5, 0.3)) / 2;
    expect(decideAutoShift(m5, { ...base, gear: 3, speed: speedFromRpm(m5, mid, 3) })).toBeNull();
  });

  it('respects the minimum dwell time', () => {
    const speed = speedFromRpm(m5, upshiftRpm(m5, 0.3) + 200, 2);
    expect(decideAutoShift(m5, { ...base, gear: 2, speed, sinceLastShiftMs: 100 })).toBeNull();
  });

  it('downshifts when RPM drops, but never into an over-rev', () => {
    const slow = speedFromRpm(m5, 1000, 4);
    expect(decideAutoShift(m5, { ...base, throttle: 0, gear: 4, speed: slow })).toBe(3);
    expect(isManualDownshiftSafe(m5, speedFromRpm(m5, 6000, 3), 2)).toBe(false);
    expect(isManualDownshiftSafe(m5, speedFromRpm(m5, 3000, 3), 2)).toBe(true);
  });

  it('kicks down on a fast, deep press', () => {
    const speed = speedFromRpm(m5, 1800, 6);
    const r = decideAutoShift(m5, { ...base, gear: 6, speed, throttle: 1, throttleRate: 3, sinceLastShiftMs: 2000 });
    expect(r).not.toBeNull();
    expect(r!).toBeLessThan(6);
    expect(rpmFromSpeed(m5, speed, r!)).toBeLessThan(m5.shift.kickdownMaxRpm);
  });

  it('does not hunt: a full-throttle run shifts monotonically up', () => {
    const sim = runningSim();
    sim.input.press('p');
    const gears: number[] = [];
    run(sim, 14, () => gears.push(sim.state.gear));
    let downs = 0;
    for (let i = 1; i < gears.length; i++) if (gears[i] < gears[i - 1]) downs++;
    expect(downs).toBe(0);
    expect(sim.state.gear).toBeGreaterThanOrEqual(4);
  });

  it('coasting downshifts back to first and the engine returns to idle', () => {
    const sim = runningSim();
    sim.input.press('p');
    run(sim, 6);
    sim.input.release('p');
    sim.returnToIdle();
    run(sim, 12);
    expect(sim.state.speed).toBe(0);
    expect(sim.state.gear).toBe(1);
    expect(Math.abs(sim.state.rpm - m5.rpm.idle)).toBeLessThan(60);
  });

  it('manual mode only shifts on request', () => {
    const sim = runningSim();
    sim.setShiftControl('manual');
    sim.input.press('p');
    run(sim, 4);
    expect(sim.state.gear).toBe(1);
    expect(sim.shiftUp()).toBe(true);
    run(sim, 0.5);
    expect(sim.state.gear).toBe(2);
  });
});

describe('Engine lifecycle', () => {
  it('cranks, runs, then stops cleanly and emits events', () => {
    const sim = new EngineSimulator(m5);
    sim.start();
    sim.step(FRAME);
    expect(sim.state.status).toBe('cranking');
    run(sim, 2);
    expect(sim.state.status).toBe('running');
    sim.stop();
    run(sim, 3);
    expect(sim.state.status).toBe('off');
    expect(sim.state.rpm).toBe(0);
    const types = sim.drainEvents().map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('stop');
    expect(sim.drainEvents()).toHaveLength(0);
  });

  it('launch demo holds launch RPM, then accelerates through the gears', () => {
    const sim = runningSim();
    sim.launch();
    run(sim, 1.2);
    expect(sim.state.speed).toBe(0);
    expect(Math.abs(sim.state.rpm - m5.rpm.launch)).toBeLessThan(500);
    run(sim, 5);
    expect(sim.state.speed).toBeGreaterThan(20);
    expect(sim.state.gear).toBeGreaterThan(2);
  });

  it('a real pedal press cancels the launch script', () => {
    const sim = runningSim();
    sim.launch();
    run(sim, 0.3);
    sim.input.press('p');
    sim.step(FRAME);
    expect(sim.state.launchActive).toBe(false);
  });

  it('turbo profiles emit a blow-off on a quick lift with boost built', () => {
    const sim = runningSim();
    sim.setDemoDrive('neutral');
    sim.input.press('p');
    run(sim, 2);
    sim.drainEvents();
    sim.input.release('p');
    run(sim, 0.5);
    expect(sim.drainEvents().some((e) => e.type === 'blowoff')).toBe(true);
  });

  it('naturally aspirated profiles never build boost', () => {
    const sim = runningSim(getVehicle('porsche-911-gt3'));
    sim.setDemoDrive('neutral');
    sim.input.press('p');
    run(sim, 2);
    expect(sim.state.boost).toBe(0);
  });
});

describe('Driving mode', () => {
  it('uses GPS speed and picks a sensible gear at cruise', () => {
    const sim = runningSim();
    sim.setMode('driving');
    sim.start();
    run(sim, 2);
    for (let i = 0; i < 8 * 60; i++) {
      sim.setSpeedEstimate({ speed: kmhToMs(90), acceleration: 0, valid: true });
      sim.step(FRAME);
    }
    expect(sim.state.speedSource).toBe('gps');
    expect(sim.state.gear).toBeGreaterThanOrEqual(5);
    expect(sim.state.rpm).toBeGreaterThan(m5.rpm.idle);
    expect(sim.state.rpm).toBeLessThan(3000);
  });

  it('fades to idle and marks speed unknown when the sensor is invalid', () => {
    const sim = runningSim();
    sim.setMode('driving');
    for (let i = 0; i < 4 * 60; i++) {
      sim.setSpeedEstimate({ speed: kmhToMs(80), acceleration: 1, valid: true });
      sim.step(FRAME);
    }
    for (let i = 0; i < 5 * 60; i++) {
      sim.setSpeedEstimate({ speed: 0, acceleration: 0, valid: false });
      sim.step(FRAME);
    }
    expect(sim.state.speedSource).toBe('none');
    expect(sim.state.rpm).toBeLessThan(m5.rpm.idle + 80);
    expect(sim.state.load).toBeLessThan(0.05);
  });

  it('forces automatic shifting in driving mode', () => {
    const sim = runningSim();
    sim.setMode('driving');
    sim.setShiftControl('manual');
    expect(sim.state.shiftControl).toBe('auto');
    expect(sim.shiftUp()).toBe(false);
  });
});

describe('Driving mode responsiveness (GPS at 1 Hz)', () => {

  function drive(profile: (t: number) => number, seconds: number, each: (t: number, sim: EngineSimulator) => void) {
    const sim = runningSim();
    sim.setMode('driving');
    const est = new SpeedEstimator();
    let nextFix = 0;
    for (let t = 0; t < seconds; t += FRAME) {
      if (t >= nextFix) {
        est.addFix({ timestamp: t * 1000, latitude: 32, longitude: 34, accuracy: 5, speed: profile(t) });
        nextFix += 1;
      }
      sim.setSpeedEstimate(est.read(t * 1000));
      sim.step(FRAME);
      each(t, sim);
    }
  }

  it('cuts the throttle sound within ~1.5 s of hard braking', () => {
    const cruise = kmhToMs(80);
    const v = (t: number) => (t < 10 ? cruise : Math.max(0, cruise - 6 * (t - 10)));
    let throttleAt = 1;
    let overrunAt = 0;
    drive(v, 11.6, (t, sim) => {
      if (t > 11.5 && t < 11.52) {
        throttleAt = sim.state.throttle;
        overrunAt = sim.state.overrun;
      }
    });
    expect(throttleAt).toBeLessThan(0.1);
    expect(overrunAt).toBeGreaterThan(0);
  });

  it('builds load within ~1.5 s of accelerating', () => {
    const v = (t: number) => (t < 8 ? kmhToMs(40) : kmhToMs(40) + 3.5 * (t - 8));
    let loadAt = 0;
    drive(v, 9.6, (t, sim) => {
      if (t > 9.5 && t < 9.52) loadAt = sim.state.load;
    });
    expect(loadAt).toBeGreaterThan(0.25);
  });
});
