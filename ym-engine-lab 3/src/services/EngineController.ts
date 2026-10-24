/**
 * Orchestrates simulation + audio + GPS + frame loop, independent of React.
 *
 * The frame loop runs at display rate and touches only the simulator, the audio
 * graph and canvas readers. React receives a throttled snapshot (~12 Hz) plus
 * immediate snapshots on discrete changes (gear, status, mode…).
 */
import { AudioEngine, type AudioStatus, type VoiceKind } from '../features/audio/AudioEngine';
import { GpsTracker, type GpsStatus } from '../features/driving-mode/gpsTracker';
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
  gpsStats: { intervalMs: number | null; speedSource: 'device' | 'position' | 'none'; fixes: number };
  gpsConsent: boolean;
  volume: number;
  started: boolean;
}

const UI_INTERVAL_MS = 80;
const STORAGE_KEY = 'ym-engine-lab:prefs';

interface Prefs {
  vehicleId: string;
  volume: number;
  shiftControl: ShiftControl;
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { vehicleId: DEFAULT_VEHICLE_ID, volume: 0.75, shiftControl: 'auto' };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      vehicleId: typeof p.vehicleId === 'string' ? getVehicle(p.vehicleId).id : fallback.vehicleId,
      volume: typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1 ? p.volume : fallback.volume,
      shiftControl: p.shiftControl === 'manual' ? 'manual' : 'auto',
    };
  } catch {
    return fallback;
  }
}

export class EngineController {
  readonly sim: EngineSimulator;
  readonly audio: AudioEngine;
  readonly gps: GpsTracker;
  private raf = 0;
  private lastFrame = 0;
  private lastUi = 0;
  private listeners = new Set<() => void>();
  private snapshot: UiSnapshot;
  private volume: number;
  private gpsConsent = false;
  private started = false;
  private disposed = false;
  private discreteKey = '';
  private cleanup: (() => void)[] = [];

  constructor(audio = new AudioEngine(), gps = new GpsTracker()) {
    const prefs = loadPrefs();
    this.sim = new EngineSimulator(getVehicle(prefs.vehicleId));
    this.sim.setShiftControl(prefs.shiftControl);
    this.audio = audio;
    this.gps = gps;
    this.volume = prefs.volume;
    this.audio.setVolume(this.volume);
    this.snapshot = this.buildSnapshot();
    this.cleanup.push(this.audio.onStatus(() => this.emit(true)));
    this.cleanup.push(this.gps.onStatus(() => this.emit(true)));
    this.installLifecycleGuards();
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
      gpsConsent: this.gpsConsent,
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
      const prefs: Prefs = { vehicleId: this.sim.vehicle.id, volume: this.volume, shiftControl: this.sim.state.shiftControl };
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
    if (s.mode === 'driving') this.sim.setSpeedEstimate(this.gps.read());
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
        if (this.sim.state.mode === 'driving' && this.gpsConsent) this.gps.start();
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
    this.disableGps();
    this.started = false;
    this.emit(true);
    // Let the shutdown ramp play before closing the context.
    await new Promise((r) => setTimeout(r, 450));
    this.stopLoop();
    await this.audio.dispose();
    this.sim.setMode('demo');
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
    if (mode === 'demo') this.disableGps();
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

  pressPedal(source: string): void {
    this.sim.input.press(source);
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

  /** Called only from the explicit "Allow location" button in Driving Mode. */
  enableGps(): void {
    this.gpsConsent = true;
    this.gps.start();
    this.emit(true);
  }

  disableGps(): void {
    this.gpsConsent = false;
    this.gps.stop();
    this.emit(true);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopLoop();
    this.sim.releaseThrottle();
    this.gps.stop();
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    this.listeners.clear();
    await this.audio.dispose();
  }
}
