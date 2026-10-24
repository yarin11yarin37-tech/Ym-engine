/**
 * Framework-independent engine + drivetrain simulation.
 *
 * Call `step(dt)` once per animation frame. The simulator never touches the DOM
 * or audio; the audio engine reads `state` and `drainEvents()` each frame.
 *
 * Demo mode simulates a *virtual* vehicle (or free-revving in neutral).
 * Driving mode derives RPM from an external speed estimate (GPS) — the numbers
 * it produces are a sound-design model, not the car's real engine state.
 */
import { coupledRpm, rpmFromSpeed, torqueCurve } from './drivetrain';
import { decideAutoShift, isManualDownshiftSafe } from './gearbox';
import { ThrottleInput, stepThrottle } from './throttleInput';
import type { DemoDrive, ShiftControl, SimEvent, SimulationMode, SimulationState, VehicleProfile } from './types';
import { clamp, progress, smoothToward } from '../utils/math';

export interface SpeedEstimate {
  /** m/s */
  speed: number;
  /** m/s² */
  acceleration: number;
  /** false when the sensor is stale, inaccurate or unavailable. */
  valid: boolean;
}

const CRANK_TIME = 0.55;
const LIMITER_CUT_S = 0.055;
const DRAG_COEF = 0.00028;
const ROLLING = 0.12;
const COAST_ASSIST = 0.55;
const LAUNCH_HOLD_S = 1.7;
const LAUNCH_MAX_S = 8;

type LaunchPhase = 'none' | 'hold' | 'go';

export class EngineSimulator {
  readonly input = new ThrottleInput();
  private profile: VehicleProfile;
  private events: SimEvent[] = [];
  private crankTimer = 0;
  private limiterTimer = 0;
  private shiftTimer = 0;
  private shiftDirection: 'up' | 'down' = 'up';
  private sinceShiftMs = 10_000;
  private throttleRate = 0;
  private time = 0;
  private blipTimer = 0;
  private launchPhase: LaunchPhase = 'none';
  private launchTimer = 0;
  private returningToIdle = false;
  private speedEstimate: SpeedEstimate = { speed: 0, acceleration: 0, valid: false };
  private boostPeak = 0;
  private throttlePeak = 0;

  state: SimulationState;

  constructor(profile: VehicleProfile) {
    this.profile = profile;
    this.state = this.initialState(profile);
  }

  private initialState(p: VehicleProfile): SimulationState {
    return {
      vehicleId: p.id,
      mode: 'demo',
      shiftControl: 'auto',
      demoDrive: 'drive',
      status: 'off',
      rpm: 0,
      rpmNorm: 0,
      throttle: 0,
      load: 0,
      fuel: 0,
      gear: 1,
      gearCount: p.gearRatios.length,
      shifting: false,
      speed: 0,
      speedSource: 'virtual',
      boost: 0,
      limiterActive: false,
      overrun: 0,
      temperature: 42,
      launchActive: false,
    };
  }

  get vehicle(): VehicleProfile {
    return this.profile;
  }

  // ───────────────────────── configuration ─────────────────────────

  setVehicle(profile: VehicleProfile): void {
    const prev = this.state;
    this.profile = profile;
    this.state = {
      ...this.initialState(profile),
      mode: prev.mode,
      shiftControl: prev.shiftControl,
      demoDrive: prev.demoDrive,
      status: prev.status === 'off' ? 'off' : 'running',
      rpm: prev.status === 'off' ? 0 : profile.rpm.idle,
      fuel: prev.status === 'off' ? 0 : 1,
      temperature: prev.temperature,
      speedSource: prev.speedSource,
    };
    this.cancelScripts();
  }

  setMode(mode: SimulationMode): void {
    this.state.mode = mode;
    this.state.speedSource = mode === 'demo' ? 'virtual' : 'gps';
    this.cancelScripts();
    this.input.releaseAll();
    this.state.speed = 0;
    this.state.gear = 1;
    if (mode === 'driving') this.state.shiftControl = 'auto';
  }

  setShiftControl(control: ShiftControl): void {
    if (this.state.mode === 'driving') return; // virtual gearbox is always automatic while driving
    this.state.shiftControl = control;
  }

  setDemoDrive(drive: DemoDrive): void {
    this.state.demoDrive = drive;
    this.cancelScripts();
    if (drive === 'neutral') this.state.speed = 0;
    this.state.gear = drive === 'neutral' ? 0 : 1;
  }

  setSpeedEstimate(estimate: SpeedEstimate): void {
    this.speedEstimate = estimate;
  }

  // ───────────────────────── engine control ─────────────────────────

  start(): void {
    if (this.state.status === 'running' || this.state.status === 'cranking') return;
    this.state.status = 'cranking';
    this.crankTimer = 0;
    this.events.push({ type: 'start' });
  }

  stop(): void {
    if (this.state.status === 'off' || this.state.status === 'stopping') return;
    this.input.releaseAll();
    this.cancelScripts();
    this.state.status = 'stopping';
  }

  /** Instant release of every throttle source (blur, tab hidden, unmount). */
  releaseThrottle(): void {
    this.input.releaseAll();
    this.cancelScripts();
  }

  shiftUp(): boolean {
    const s = this.state;
    if (s.status !== 'running' || s.mode !== 'demo' || s.demoDrive !== 'drive' || s.shifting) return false;
    if (s.gear >= this.profile.gearRatios.length) return false;
    this.beginShift(s.gear + 1);
    return true;
  }

  shiftDown(): boolean {
    const s = this.state;
    if (s.status !== 'running' || s.mode !== 'demo' || s.demoDrive !== 'drive' || s.shifting) return false;
    if (s.gear <= 1 || !isManualDownshiftSafe(this.profile, s.speed, s.gear - 1)) return false;
    this.beginShift(s.gear - 1);
    return true;
  }

  /** Short throttle blip. */
  blip(): void {
    if (this.state.status !== 'running' || this.launchPhase !== 'none') return;
    this.blipTimer = 0.14;
    this.input.setOverride(1);
  }

  /** Parked launch-control demonstration: rev hold, release, run through the gears, lift. */
  launch(): void {
    const s = this.state;
    if (s.status !== 'running' || s.mode !== 'demo') return;
    if (s.demoDrive !== 'drive') this.setDemoDrive('drive');
    s.speed = 0;
    s.gear = 1;
    this.returningToIdle = false;
    this.launchPhase = 'hold';
    this.launchTimer = 0;
    this.input.setOverride(1);
  }

  /** Lift off, brake the virtual vehicle to a stop and settle at idle. */
  returnToIdle(): void {
    this.cancelScripts();
    this.input.releaseAll();
    this.returningToIdle = true;
  }

  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return this.events;
    const out = this.events;
    this.events = [];
    return out;
  }

  private cancelScripts(): void {
    this.launchPhase = 'none';
    this.launchTimer = 0;
    this.blipTimer = 0;
    this.returningToIdle = false;
    this.input.setOverride(null);
    this.state.launchActive = false;
  }

  private beginShift(to: number): void {
    const s = this.state;
    this.shiftDirection = to > s.gear ? 'up' : 'down';
    this.events.push({ type: 'shift', direction: this.shiftDirection, from: s.gear, to, load: s.load });
    s.gear = to;
    s.shifting = true;
    this.shiftTimer = this.profile.shift.durationMs / 1000;
    this.sinceShiftMs = 0;
  }

  // ───────────────────────── main step ─────────────────────────

  step(dtRaw: number): SimulationState {
    // Clamp dt so a stalled frame (tab switch) cannot launch the simulation.
    const dt = clamp(Number.isFinite(dtRaw) ? dtRaw : 0, 0, 0.05);
    const s = this.state;
    const p = this.profile;
    this.time += dt;
    this.sinceShiftMs += dt * 1000;

    this.updateScripts(dt);

    // Pedal → throttle.
    const prev = s.throttle;
    if (s.mode === 'demo') {
      const target = s.status === 'running' ? this.input.target : 0;
      s.throttle = stepThrottle(s.throttle, target, dt, p.response.throttleRiseTime);
    }
    const rawRate = dt > 0 ? (s.throttle - prev) / dt : 0;
    this.throttleRate = smoothToward(this.throttleRate, rawRate, dt, 0.05);

    // Limiter (fuel cut bounce).
    if (this.limiterTimer > 0) this.limiterTimer -= dt;
    const limitRpm = this.launchPhase === 'hold' ? p.rpm.launch : p.rpm.limiter;
    if (s.status === 'running' && s.rpm >= limitRpm && this.limiterTimer <= 0) {
      this.limiterTimer = LIMITER_CUT_S;
      if (this.launchPhase !== 'hold') this.events.push({ type: 'limiter' });
    }
    s.limiterActive = this.limiterTimer > 0;

    // Shift timing.
    if (s.shifting) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) s.shifting = false;
    }

    switch (s.status) {
      case 'off':
        s.rpm = smoothToward(s.rpm, 0, dt, 0.25);
        s.fuel = 0;
        break;
      case 'cranking':
        this.stepCranking(dt);
        break;
      case 'stopping':
        s.fuel = 0;
        s.rpm = smoothToward(s.rpm, 0, dt, 0.32);
        s.speed = this.state.mode === 'demo' ? Math.max(0, s.speed - 6 * dt) : s.speed;
        if (s.rpm < 25) {
          s.rpm = 0;
          s.status = 'off';
          this.events.push({ type: 'stop' });
        }
        break;
      case 'running':
        if (s.mode === 'demo') this.stepDemo(dt);
        else this.stepDriving(dt);
        break;
    }

    this.stepCommon(dt, prev);
    return s;
  }

  private updateScripts(dt: number): void {
    const s = this.state;
    if (this.input.pressed && (this.launchPhase !== 'none' || this.returningToIdle)) {
      // Any real pedal press takes priority over a script.
      this.launchPhase = 'none';
      this.returningToIdle = false;
      this.input.setOverride(null);
    }
    if (this.blipTimer > 0) {
      this.blipTimer -= dt;
      if (this.blipTimer <= 0) this.input.setOverride(null);
    }
    if (this.launchPhase === 'hold') {
      this.launchTimer += dt;
      if (this.launchTimer >= LAUNCH_HOLD_S) {
        this.launchPhase = 'go';
        this.launchTimer = 0;
      }
    } else if (this.launchPhase === 'go') {
      this.launchTimer += dt;
      const topGear = s.gear >= this.profile.gearRatios.length - 2;
      if (this.launchTimer >= LAUNCH_MAX_S || s.speed > 66 || (topGear && s.rpm > this.profile.shift.upFull * 0.92)) {
        this.launchPhase = 'none';
        this.input.setOverride(null);
        this.returningToIdle = true;
      }
    }
    s.launchActive = this.launchPhase !== 'none';
  }

  private stepCranking(dt: number): void {
    const s = this.state;
    const p = this.profile;
    this.crankTimer += dt;
    if (this.crankTimer < CRANK_TIME) {
      // Starter motor: low, uneven compression strokes, no combustion yet.
      s.fuel = 0.12;
      s.rpm = smoothToward(s.rpm, 240, dt, 0.08);
    } else {
      // Catch and flare.
      s.fuel = 1;
      s.rpm = smoothToward(s.rpm, p.rpm.idle * 2.1, dt, 0.11);
      if (s.rpm >= p.rpm.idle * 1.75) {
        s.status = 'running';
        s.gear = s.mode === 'demo' && s.demoDrive === 'neutral' ? 0 : 1;
      }
    }
  }

  private idleWobble(): number {
    const t = this.time;
    return 9 * Math.sin(t * 2.3) + 5 * Math.sin(t * 6.1 + 1.3) + 3 * Math.sin(t * 0.7 + 0.4);
  }

  private effectiveThrottle(): number {
    const s = this.state;
    let thr = s.throttle;
    if (s.limiterActive) thr = 0;
    if (s.shifting && this.shiftDirection === 'up') thr *= 0.12; // torque cut during upshift
    return thr;
  }

  private stepDemo(dt: number): void {
    const s = this.state;
    const p = this.profile;
    const eff = this.effectiveThrottle();
    const shaped = Math.pow(eff, p.response.throttleCurve);
    const idleTarget = p.rpm.idle + this.idleWobble() * (1 - Math.min(1, s.throttle * 4));
    s.fuel = s.limiterActive ? 0 : 1;

    if (s.demoDrive === 'neutral' || this.launchPhase === 'hold') {
      const ceiling = this.launchPhase === 'hold' ? p.rpm.launch * 1.05 : p.rpm.limiter * 1.03;
      const target = Math.max(idleTarget, p.rpm.idle + shaped * (ceiling - p.rpm.idle));
      const tc = target > s.rpm ? p.response.riseTime : p.response.fallTime;
      s.rpm = smoothToward(s.rpm, target, dt, tc);
      s.speed = Math.max(0, s.speed - 8 * dt);
      s.load = smoothToward(s.load, shaped * 0.85 + (target > s.rpm + 300 ? 0.15 : 0), dt, 0.05);
      return;
    }

    // Virtual vehicle in drive.
    const ratio1 = p.gearRatios[0];
    const ratio = p.gearRatios[s.gear - 1] ?? ratio1;
    const peakAccel = (100 / 3.6 / p.response.zeroToHundred) * 1.45;
    const torque = torqueCurve(p, s.rpm);
    const gearFactor = ratio / ratio1;
    const lugging = s.rpm < p.rpm.idle * 1.3 && s.gear > 2 ? 0.45 : 1;
    let drive = s.rpm >= p.rpm.limiter ? 0 : shaped * torque * peakAccel * gearFactor * lugging;
    if (s.shifting && this.shiftDirection === 'up') drive *= 0.2;

    const v = s.speed;
    const drag = DRAG_COEF * v * v + (v > 0.05 ? ROLLING : 0);
    const closed = eff < 0.04;
    const engineBrake = closed ? p.response.engineBraking * progress(s.rpm, p.rpm.idle, p.rpm.limiter) * gearFactor : 0;
    const assist = closed && !this.input.hasOverride ? COAST_ASSIST : 0;
    const brakes = this.returningToIdle ? 7 : 0;

    s.speed = Math.max(0, v + (drive - drag - engineBrake - assist - brakes) * dt);
    if (this.returningToIdle && s.speed <= 0.05) {
      this.returningToIdle = false;
    }

    // Engine speed follows the wheels (with clutch slip in first gear at low speed).
    const target = Math.max(coupledRpm(p, s.speed, s.gear, eff), idleTarget);
    const tc = s.shifting ? Math.max(0.025, p.shift.durationMs / 1000 / 2.6) : target > s.rpm ? 0.05 : 0.07;
    s.rpm = smoothToward(s.rpm, target, dt, tc);

    if (s.shiftControl === 'auto') {
      const decision = decideAutoShift(p, {
        gear: s.gear,
        rpm: s.rpm,
        speed: s.speed,
        throttle: s.throttle,
        throttleRate: this.throttleRate,
        sinceLastShiftMs: this.sinceShiftMs,
        shifting: s.shifting,
      });
      if (decision !== null && decision !== s.gear) this.beginShift(decision);
    }

    const wheelLoad = shaped * (0.55 + 0.45 * torque);
    s.load = smoothToward(s.load, s.shifting && this.shiftDirection === 'up' ? 0.08 : wheelLoad, dt, 0.04);
  }

  private stepDriving(dt: number): void {
    const s = this.state;
    const p = this.profile;
    const est = this.speedEstimate;
    s.fuel = 1;
    const idleTarget = p.rpm.idle + this.idleWobble();

    if (!est.valid) {
      // No trustworthy sensor data: fade gracefully to idle, never fabricate motion.
      s.throttle = smoothToward(s.throttle, 0, dt, 0.3);
      s.load = smoothToward(s.load, 0, dt, 0.4);
      s.rpm = smoothToward(s.rpm, idleTarget, dt, 0.9);
      s.speedSource = 'none';
      return;
    }
    s.speedSource = 'gps';
    s.speed = Math.max(0, est.speed);

    // Estimate how hard the virtual engine would be working from acceleration.
    const ratio1 = p.gearRatios[0];
    const gearIdx = Math.max(1, s.gear);
    const peakAccel = (100 / 3.6 / p.response.zeroToHundred) * 1.45;
    const available = peakAccel * (p.gearRatios[gearIdx - 1] / ratio1) * torqueCurve(p, s.rpm);
    const required = est.acceleration + DRAG_COEF * s.speed * s.speed + (s.speed > 0.5 ? ROLLING : 0);
    const thrEstimate = est.acceleration < -0.35 ? 0 : clamp(required / Math.max(0.3, available), 0, 1);
    // Throttle in driving mode is an *estimate* derived from motion, never the real pedal.
    s.throttle = smoothToward(s.throttle, thrEstimate, dt, 0.35);

    if (s.speed < 0.6) {
      if (s.gear !== 1 && !s.shifting) s.gear = 1;
      s.rpm = smoothToward(s.rpm, idleTarget + s.throttle * 600, dt, 0.25);
    } else {
      const decision = decideAutoShift(p, {
        gear: Math.max(1, s.gear),
        rpm: s.rpm,
        speed: s.speed,
        throttle: s.throttle,
        throttleRate: this.throttleRate,
        sinceLastShiftMs: this.sinceShiftMs,
        shifting: s.shifting,
      });
      if (decision !== null && decision !== s.gear) this.beginShift(decision);
      const target = Math.max(coupledRpm(p, s.speed, Math.max(1, s.gear), s.throttle), idleTarget);
      const tc = s.shifting ? Math.max(0.03, p.shift.durationMs / 1000 / 2.4) : 0.12;
      s.rpm = smoothToward(s.rpm, Math.min(target, p.rpm.limiter), dt, tc);
    }
    s.load = smoothToward(s.load, s.shifting && this.shiftDirection === 'up' ? 0.1 : s.throttle, dt, 0.08);
  }

  private stepCommon(dt: number, prevThrottle: number): void {
    const s = this.state;
    const p = this.profile;
    s.rpm = clamp(s.rpm, 0, p.rpm.max);
    s.rpmNorm = progress(s.rpm, p.rpm.idle, p.rpm.limiter);

    // Overrun: closed throttle with the engine being driven above idle.
    const closed = s.throttle < 0.05 && s.status === 'running';
    const overrunTarget = closed ? progress(s.rpm, p.rpm.idle * 2.4, p.rpm.redline) : 0;
    s.overrun = smoothToward(s.overrun, overrunTarget, dt, closed ? 0.05 : 0.02);

    // Boost.
    if (p.induction === 'none') {
      s.boost = 0;
    } else if (p.induction === 'supercharger') {
      const target = s.status === 'running' ? s.throttle * (0.35 + 0.65 * s.rpmNorm) : 0;
      s.boost = smoothToward(s.boost, target, dt, p.boost.spoolTime);
    } else {
      const avail = progress(s.rpm, p.boost.thresholdRpm, p.boost.thresholdRpm + 1600);
      const target = s.status === 'running' ? s.throttle * avail * (s.limiterActive ? 0.85 : 1) : 0;
      const tc = target > s.boost ? p.boost.spoolTime : 0.18;
      s.boost = smoothToward(s.boost, target, dt, tc);
      this.boostPeak = Math.max(this.boostPeak * Math.exp(-dt / 0.5), s.boost);
      this.throttlePeak = Math.max(this.throttlePeak * Math.exp(-dt / 0.25), prevThrottle, s.throttle);
      // Blow-off on a quick lift (recent throttle was high, now closed) with boost built up.
      if (this.throttlePeak > 0.55 && s.throttle < 0.2 && this.boostPeak > 0.35) {
        this.events.push({ type: 'blowoff', boost: this.boostPeak });
        this.boostPeak = 0;
        this.throttlePeak = 0;
      }
    }

    // Simulated coolant temperature (display only, clearly labelled SIM in the UI).
    const tempTarget = s.status === 'off' ? 42 : 88 + s.load * 9;
    s.temperature = smoothToward(s.temperature, tempTarget, dt, s.status === 'off' ? 400 : 90);
    s.gearCount = p.gearRatios.length;
    if (s.mode === 'demo' && s.demoDrive === 'neutral') s.gear = 0;
  }
}

/** Expose for tests and diagnostics. */
export function wheelRpm(profile: VehicleProfile, speed: number, gear: number): number {
  return rpmFromSpeed(profile, speed, gear);
}
