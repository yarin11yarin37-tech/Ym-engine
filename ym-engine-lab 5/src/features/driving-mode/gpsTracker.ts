/**
 * Browser geolocation wrapper for Driving Mode.
 *
 * - Only starts after an explicit call (made from the user's consent action).
 * - Watches position while active; `stop()` clears the watcher immediately.
 * - Location stays in memory on this device: nothing is uploaded or persisted.
 */
import { SpeedEstimator, type GpsFix, type SpeedReading } from './speedEstimator';

export type GpsStatus =
  | 'inactive'
  | 'unsupported'
  | 'insecure-context'
  | 'awaiting-permission'
  | 'denied'
  | 'acquiring'
  | 'connected'
  | 'poor-accuracy'
  | 'lost';

export interface GeolocationLike {
  watchPosition(
    success: (p: GeolocationPosition) => void,
    error?: (e: GeolocationPositionError) => void,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
  getCurrentPosition?(
    success: (p: GeolocationPosition) => void,
    error?: (e: GeolocationPositionError) => void,
    options?: PositionOptions,
  ): void;
}

const ERROR_NAME: Record<number, string> = { 1: 'permission denied', 2: 'position unavailable', 3: 'timeout' };

/**
 * Car browsers differ: some fail high-accuracy requests, some never fire
 * watchPosition but answer getCurrentPosition. So the tracker:
 *  1. watches with high accuracy,
 *  2. falls back to a low-accuracy watch after repeated errors,
 *  3. polls getCurrentPosition whenever no fix has arrived for a moment.
 */
export class GpsTracker {
  readonly estimator = new SpeedEstimator();
  private watchId: number | null = null;
  private active = false;
  private highAccuracy = true;
  private errorsWithoutFix = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollPending = false;
  private startedAt = 0;
  private _status: GpsStatus = 'inactive';
  private lastAccuracy: number | null = null;
  private listeners = new Set<(s: GpsStatus) => void>();
  private lastFixAt = -Infinity;
  private _lastError: string | null = null;
  private static readonly LOST_AFTER_MS = 9000;
  private static readonly GIVE_UP_FIRST_FIX_MS = 25_000;

  constructor(
    private readonly geo: GeolocationLike | undefined = typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
    private readonly secure: boolean = typeof window !== 'undefined' ? window.isSecureContext !== false : true,
    private readonly clock: () => number = () => Date.now(),
    private readonly poll: boolean = typeof window !== 'undefined',
  ) {}

  get status(): GpsStatus {
    return this._status;
  }

  /** Update rate and speed source, for diagnostics (no coordinates). */
  get stats() {
    return this.estimator.stats;
  }

  /** Last geolocation error reported by the browser, for diagnostics. */
  get lastError(): string | null {
    return this._lastError;
  }

  /** Whether the tracker had to fall back to low-accuracy requests. */
  get lowAccuracyMode(): boolean {
    return !this.highAccuracy;
  }

  /** Last reported accuracy radius in metres (no coordinates are exposed). */
  get accuracy(): number | null {
    return this.lastAccuracy;
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }

  onStatus(fn: (s: GpsStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: GpsStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.listeners.forEach((fn) => fn(s));
  }

  private options(): PositionOptions {
    return this.highAccuracy
      ? { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 }
      : { enableHighAccuracy: false, maximumAge: 3000, timeout: 20_000 };
  }

  private beginWatch(): void {
    if (!this.geo) return;
    if (this.watchId !== null) this.geo.clearWatch(this.watchId);
    try {
      this.watchId = this.geo.watchPosition(
        (pos) => this.handlePosition(pos),
        (err) => this.handleError(err),
        this.options(),
      );
    } catch {
      this.watchId = null;
    }
  }

  start(): void {
    if (this.active) return;
    if (!this.geo) return this.setStatus('unsupported');
    if (!this.secure) return this.setStatus('insecure-context');
    this.estimator.reset();
    this.active = true;
    this.highAccuracy = true;
    this.errorsWithoutFix = 0;
    this._lastError = null;
    this.startedAt = this.clock();
    this.setStatus('awaiting-permission');
    this.beginWatch();
    if (this.watchId === null && !this.geo.getCurrentPosition) {
      this.active = false;
      return this.setStatus('unsupported');
    }
    if (this.poll && this.geo.getCurrentPosition) {
      this.pollTimer = setInterval(() => this.pollOnce(), 1000);
      this.pollOnce();
    }
  }

  private pollOnce(): void {
    if (!this.active || this.pollPending || !this.geo?.getCurrentPosition) return;
    if (this.clock() - this.lastFixAt < 2500) return;
    this.pollPending = true;
    try {
      this.geo.getCurrentPosition(
        (pos) => {
          this.pollPending = false;
          this.handlePosition(pos);
        },
        (err) => {
          this.pollPending = false;
          this.handleError(err);
        },
        { ...this.options(), timeout: 8000 },
      );
    } catch {
      this.pollPending = false;
    }
  }

  stop(): void {
    this.active = false;
    if (this.watchId !== null && this.geo) this.geo.clearWatch(this.watchId);
    this.watchId = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollPending = false;
    this.estimator.reset();
    this.lastAccuracy = null;
    this.lastFixAt = -Infinity;
    this.setStatus('inactive');
  }

  private handlePosition(pos: GeolocationPosition): void {
    if (!this.active) return;
    const fix: GpsFix = {
      // Receipt time on this device's clock (see SpeedEstimator.addFix).
      timestamp: this.clock(),
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      speed: pos.coords.speed,
    };
    this.errorsWithoutFix = 0;
    this._lastError = null;
    this.lastAccuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : null;
    this.lastFixAt = fix.timestamp;
    const quality = this.estimator.addFix(fix);
    if (quality === 'good') this.setStatus('connected');
    else if (quality === 'poor-accuracy') this.setStatus('poor-accuracy');
  }

  private handleError(err: GeolocationPositionError): void {
    if (!this.active) return;
    this._lastError = `${ERROR_NAME[err.code] ?? `error ${err.code}`}${err.message ? `: ${err.message}` : ''}`;
    if (err.code === 1) {
      this.stop();
      this._lastError = 'permission denied';
      this.setStatus('denied');
      return;
    }
    this.errorsWithoutFix++;
    // High-accuracy requests fail on some devices: retry without it.
    if (this.highAccuracy && this.errorsWithoutFix >= 2) {
      this.highAccuracy = false;
      this.beginWatch();
    }
    const neverHadFix = !Number.isFinite(this.lastFixAt);
    if (neverHadFix) {
      const waited = this.clock() - this.startedAt;
      this.setStatus(waited > GpsTracker.GIVE_UP_FIRST_FIX_MS ? 'lost' : 'acquiring');
    }
    // With earlier fixes, staleness is decided in read(), not by a single error.
  }

  /** Call every frame. Updates the stale/lost status and returns the current reading. */
  read(): SpeedReading {
    const now = this.clock();
    const r = this.estimator.read(now);
    const noFixes = now - this.lastFixAt > GpsTracker.LOST_AFTER_MS;
    // "Lost" means positions stopped arriving or a speed estimate went stale —
    // not merely that the very first fix hasn't produced a speed yet.
    const stale = !r.valid && (Number.isFinite(r.ageMs) || noFixes);
    if (this._status === 'connected' && stale) this.setStatus('lost');
    if (this._status === 'poor-accuracy' && noFixes) this.setStatus('lost');
    if (this._status === 'lost' && r.valid) this.setStatus('connected');
    if (this._status === 'acquiring' && now - this.startedAt > GpsTracker.GIVE_UP_FIRST_FIX_MS) this.setStatus('lost');
    return r;
  }
}

export const GPS_STATUS_LABEL: Record<GpsStatus, string> = {
  inactive: 'GPS off',
  unsupported: 'Location not supported by this browser',
  'insecure-context': 'Location needs HTTPS',
  'awaiting-permission': 'Waiting for location',
  denied: 'Location permission denied',
  acquiring: 'Acquiring GPS signal',
  connected: 'GPS connected',
  'poor-accuracy': 'Poor GPS accuracy',
  lost: 'No GPS data',
};
