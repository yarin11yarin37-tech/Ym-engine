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
}

export class GpsTracker {
  readonly estimator = new SpeedEstimator();
  private watchId: number | null = null;
  private _status: GpsStatus = 'inactive';
  private lastAccuracy: number | null = null;
  private listeners = new Set<(s: GpsStatus) => void>();
  private poorSince: number | null = null;

  constructor(
    private readonly geo: GeolocationLike | undefined = typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
    private readonly secure: boolean = typeof window !== 'undefined' ? window.isSecureContext : true,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get status(): GpsStatus {
    return this._status;
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

  start(): void {
    if (this.watchId !== null) return;
    if (!this.geo) return this.setStatus('unsupported');
    if (!this.secure) return this.setStatus('insecure-context');
    this.estimator.reset();
    this.setStatus('awaiting-permission');
    try {
      this.watchId = this.geo.watchPosition(
        (pos) => this.handlePosition(pos),
        (err) => this.handleError(err),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
      );
    } catch {
      this.setStatus('unsupported');
    }
  }

  stop(): void {
    if (this.watchId !== null && this.geo) this.geo.clearWatch(this.watchId);
    this.watchId = null;
    this.estimator.reset();
    this.lastAccuracy = null;
    this.poorSince = null;
    this.setStatus('inactive');
  }

  private handlePosition(pos: GeolocationPosition): void {
    if (this.watchId === null) return;
    const fix: GpsFix = {
      timestamp: pos.timestamp || this.clock(),
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      speed: pos.coords.speed,
    };
    this.lastAccuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : null;
    const quality = this.estimator.addFix(fix);
    if (quality === 'good') {
      this.poorSince = null;
      this.setStatus('connected');
    } else if (quality === 'poor-accuracy') {
      this.poorSince ??= this.clock();
      this.setStatus('poor-accuracy');
    }
  }

  private handleError(err: GeolocationPositionError): void {
    if (err.code === 1) {
      this.setStatus('denied');
      if (this.watchId !== null && this.geo) this.geo.clearWatch(this.watchId);
      this.watchId = null;
    } else if (this._status === 'awaiting-permission') {
      this.setStatus('acquiring');
    } else {
      this.setStatus('lost');
    }
  }

  /** Call every frame. Updates the stale/lost status and returns the current reading. */
  read(): SpeedReading {
    const r = this.estimator.read(this.clock());
    const active = this._status === 'connected' || this._status === 'poor-accuracy' || this._status === 'lost';
    if (active && !r.valid && this._status !== 'poor-accuracy') this.setStatus('lost');
    if (this._status === 'lost' && r.valid) this.setStatus('connected');
    return r;
  }
}

export const GPS_STATUS_LABEL: Record<GpsStatus, string> = {
  inactive: 'GPS off',
  unsupported: 'Location not supported by this browser',
  'insecure-context': 'Location needs HTTPS',
  'awaiting-permission': 'Waiting for permission',
  denied: 'Location permission denied',
  acquiring: 'Acquiring GPS signal',
  connected: 'GPS connected',
  'poor-accuracy': 'Poor GPS accuracy',
  lost: 'GPS signal lost',
};
