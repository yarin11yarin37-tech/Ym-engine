/**
 * Orchestrates simulation + audio + GPS + frame loop, independent of React.
 *
 * The frame loop runs at display rate and touches only the simulator, the audio
 * graph and canvas readers. React receives a throttled snapshot (~12 Hz) plus
 * immediate snapshots on discrete changes (gear, status, mode…).
 */
import { AudioEngine, type AudioStatus, type VoiceKind } from '../features/audio/AudioEngine';
import { GpsTracker, type GpsStatus } from '../features/driving-mode/gpsTracker';
import { MotionSensor, type MotionStatus } from '../features/driving-mode/motionSensor';
import { SpeedFusion } from '../features/driving-mode/speedFusion';
import { DEFAULT_VEHICLE_ID, getVehicle } from '../data/vehicles';
import { EngineSimulator } from '../simulation/EngineSimulator';
import type { DemoDrive, ShiftControl, SimulationMode, SimulationState, VehicleProfile } from '../simulation/types';

export interface UiSnapshot {
  sim: SimulationState;
  vehicle: VehicleProfile;
  audioStatus: AudioStatus;
  voiceKind: VoiceKind;
  audioError: string | null;
  gpsStatus: GpsStatus;
  gpsAccuracy: number | null;
  gpsError: string | null;
  gpsLowAccuracy: boolean;
  motionStatus: MotionStatus;
  motionConfidence: number;
  gpsStats: { intervalMs: number | null; speedSource: 'device' | 'position' | 'none'; fixes: number };
  volume: number;
  started: boolean;
}

const UI_INTERVAL_MS = 80;
const STORAGE_KEY = 'ym-engine-lab:prefs';

interface Prefs {
  vehicleId: string;
  volume: number;
  shiftControl: ShiftControl;
  mode: SimulationMode;
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { vehicleId: DEFAULT_VEHICLE_ID, volume: 0.75, shiftControl: 'auto', mode: 'demo' };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      vehicleId: typeof p.vehicleId === 'string' ? getVehicle(p.vehicleId).id : fallback.vehicleId,
      volume: typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1 ? p.volume : fallback.volume,
      shiftControl: p.shiftControl === 'manual' ? 'manual' : 'auto',
      mode: p.mode === 'driving' ? 'driving' : 'demo',
    };
  } catch {
    return fallback;
  }
}

export class EngineController {
  readonly sim: EngineSimulator;
  readonly audio: AudioEngine;
  readonly gps: GpsTracker;
  readonly motion = new MotionSensor();
  private fusion = new SpeedFusion();
  private wakeLock: { release(): Promise<void> } | null = null;
  private raf = 0;
  private lastFrame = 0;
  private lastUi = 0;
  private listeners = new Set<() => void>();
  private snapshot: UiSnapshot;
  private volume: number;
  private started = false;
  private disposed = false;
  private discreteKey = '';
  private cleanup: (() => void)[] = [];

  constructor(audio = new AudioEngine(), gps = new GpsTracker()) {
    const prefs = loadPrefs();
    this.sim = new EngineSimulator(getVehicle(prefs.vehicleId));
    this.sim.setShiftControl(prefs.shiftControl);
    if (prefs.mode === 'driving') this.sim.setMode('driving');
    this.audio = audio;
    this.gps = gps;
    this.volume = prefs.volume;
    this.audio.setVolume(this.volume);
    this.snapshot = this.buildSnapshot();
    this.cleanup.push(this.audio.onStatus(() => this.emit(true)));
    this.cleanup.push(this.gps.onStatus(() => this.emit(true)));
    this.installLifecycleGuards();
    // Driving mode syncs to GPS as soon as it is selected — no separate connect step.
    if (this.sim.state.mode === 'driving') this.gps.start();
    this.cleanup.push(this.motion.onStatus(() => this.emit(true)));
  }

  // ───────────────────────── subscription (useSyncExternalStore) ─────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): UiSnapshot => this.snapshot;

  /** Live state for rAF readers (canvas). Never use in React render. */
  get live(): SimulationState {
    return this.sim.state;
  }

  private buildSnapshot(): UiSnapshot {
    return {
      sim: { ...this.sim.state },
      vehicle: this.sim.vehicle,
      audioStatus: this.audio.status,
      voiceKind: this.audio.voiceKind,
      audioError: this.audio.lastError,
      gpsStatus: this.gps.status,
      gpsAccuracy: this.gps.accuracy,
      gpsStats: this.gps.stats,
      gpsError: this.gps.lastError,
      gpsLowAccuracy: this.gps.lowAccuracyMode,
      motionStatus: this.motion.status,
      motionConfidence: this.motion.confidence,
      volume: this.volume,
      started: this.started,
    };
  }

  private emit(force = false): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const s = this.sim.state;
    const key = `${s.status}|${s.gear}|${s.mode}|${s.shiftControl}|${s.demoDrive}|${s.vehicleId}|${s.launchActive}|${s.speedSource}`;
    const discreteChanged = key !== this.discreteKey;
    if (!force && !discreteChanged && now - this.lastUi < UI_INTERVAL_MS) return;
    this.discreteKey = key;
    this.lastUi = now;
    this.snapshot = this.buildSnapshot();
    this.listeners.forEach((fn) => fn());
  }

  private savePrefs(): void {
    try {
      const prefs: Prefs = {
        vehicleId: this.sim.vehicle.id,
        volume: this.volume,
        shiftControl: this.sim.state.shiftControl,
        mode: this.sim.state.mode,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable — preferences are optional */
    }
  }

  // ───────────────────────── frame loop ─────────────────────────

  private startLoop(): void {
    if (this.raf || this.disposed || typeof requestAnimationFrame === 'undefined') return;
    this.lastFrame = performance.now();
    const tick = (t: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = (t - this.lastFrame) / 1000;
      this.lastFrame = t;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(dt: number): void {
    const s = this.sim.state;
    if (s.mode === 'driving') {
      const gps = this.gps.read();
      // GPS teaches the motion sensor which way the phone faces; the sensor then
      // gives near-instant acceleration while GPS keeps the speed honest.
      if (gps.valid && gps.ageMs < 2000) this.motion.learn(gps.acceleration, Math.min(0.05, Math.max(0, dt)));
      this.sim.setSpeedEstimate(this.fusion.update(dt, gps, this.motion.usable ? this.motion.acceleration : null));
    }
    this.sim.step(dt);
    const events = this.sim.drainEvents();
    this.audio.update(this.sim.state);
    if (events.length) this.audio.handleEvents(events, this.sim.state);
    this.emit();
  }

  // ───────────────────────── lifecycle guards ─────────────────────────

  private installLifecycleGuards(): void {
    if (typeof window === 'undefined') return;
    const onBlur = () => this.sim.releaseThrottle();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this.sim.releaseThrottle();
        if (this.sim.state.mode === 'driving') this.gps.stop();
        void this.audio.suspend();
      } else {
        if (this.started) void this.audio.resume();
        if (this.sim.state.mode === 'driving') {
          this.gps.start();
          if (this.started) void this.requestWakeLock();
        }
        this.lastFrame = performance.now();
      }
      this.emit(true);
    };
    const onPageHide = () => this.sim.releaseThrottle();
    window.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    this.cleanup.push(() => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  // ───────────────────────── commands ─────────────────────────

  /** Call directly from a click/tap handler (audio must start inside a user gesture). */
  startEngine(): Promise<void> {
    this.started = true;
    const p = this.audio.init(this.sim.vehicle);
    this.audio.setVolume(this.volume);
    this.sim.start();
    if (this.sim.state.mode === 'driving') this.startDrivingSensors();
    this.startLoop();
    this.emit(true);
    return p.then(
      () => this.emit(true),
      () => this.emit(true),
    );
  }

  stopEngine(): void {
    this.sim.stop();
    this.emit(true);
  }

  toggleEngine(): void {
    const st = this.sim.state.status;
    if (st === 'running' || st === 'cranking') this.stopEngine();
    else void this.startEngine();
  }

  /** Leave the cockpit: stop the engine, GPS and release audio entirely. */
  async exit(): Promise<void> {
    this.sim.releaseThrottle();
    this.sim.stop();
    this.stopDrivingSensors();
    this.started = false;
    this.emit(true);
    // Let the shutdown ramp play before closing the context.
    await new Promise((r) => setTimeout(r, 450));
    this.stopLoop();
    await this.audio.dispose();
    this.emit(true);
  }

  async resumeAudio(): Promise<void> {
    const ok = await this.audio.resume();
    if (!ok && this.audio.status === 'error') await this.startEngine();
    this.emit(true);
  }

  selectVehicle(id: string): void {
    const v = getVehicle(id);
    this.sim.setVehicle(v);
    this.audio.setVehicle(v);
    this.savePrefs();
    this.emit(true);
  }

  setMode(mode: SimulationMode): void {
    if (mode === this.sim.state.mode) return;
    this.sim.setMode(mode);
    if (mode === 'driving') this.startDrivingSensors();
    else this.stopDrivingSensors();
    this.savePrefs();
    this.emit(true);
  }

  setShiftControl(c: ShiftControl): void {
    this.sim.setShiftControl(c);
    this.savePrefs();
    this.emit(true);
  }

  setDemoDrive(d: DemoDrive): void {
    this.sim.setDemoDrive(d);
    this.emit(true);
  }

  pressPedal(source: string, level = 1): void {
    this.sim.input.press(source, level);
  }
  releasePedal(source: string): void {
    this.sim.input.release(source);
  }
  releaseAll(): void {
    this.sim.releaseThrottle();
  }

  gearUp(): void {
    this.sim.shiftUp();
    this.emit(true);
  }
  gearDown(): void {
    this.sim.shiftDown();
    this.emit(true);
  }
  blip(): void {
    this.sim.blip();
  }
  launch(): void {
    this.sim.launch();
    this.emit(true);
  }
  returnToIdle(): void {
    this.sim.returnToIdle();
    this.emit(true);
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.audio.setVolume(this.volume);
    this.savePrefs();
    this.emit(true);
  }

  /** Call from a tap: iOS only grants the motion sensor inside a user gesture. */
  private startDrivingSensors(): void {
    this.gps.start();
    this.fusion.reset();
    void this.motion.start().then(() => this.emit(true));
    void this.requestWakeLock();
  }

  private stopDrivingSensors(): void {
    this.gps.stop();
    this.motion.stop();
    this.fusion.reset();
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }

  /** Keep the phone screen on while driving (ignored where unsupported). */
  private async requestWakeLock(): Promise<void> {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && !this.wakeLock) this.wakeLock = await wl.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  /** The phone was moved in its mount: learn its direction again. */
  recalibrateMotion(): void {
    this.motion.recalibrate();
    this.emit(true);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopLoop();
    this.sim.releaseThrottle();
    this.stopDrivingSensors();
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    this.listeners.clear();
    await this.audio.dispose();
  }
}
