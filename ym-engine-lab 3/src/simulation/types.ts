/**
 * Core types for the framework-independent simulation.
 * Nothing in this folder imports React or touches the DOM.
 */

export type InductionType = 'none' | 'turbo' | 'twin-turbo' | 'supercharger';
export type TransmissionKind = 'automatic' | 'dual-clutch' | 'manual';
export type SimulationMode = 'demo' | 'driving';
export type ShiftControl = 'auto' | 'manual';
/** Demo-mode drivetrain: free-revving in neutral or a virtual vehicle in drive. */
export type DemoDrive = 'neutral' | 'drive';

/** One exhaust resonance (a band-pass mode excited by each firing pulse). */
export interface ResonatorSpec {
  /** Centre frequency in Hz at idle. */
  freq: number;
  /** Fraction of firing-frequency change that the resonance follows (0 = fixed pipe mode). */
  track: number;
  /** Quality factor. */
  q: number;
  gain: number;
}

/** A tonal layer locked to an engine order (multiple of crank frequency). */
export interface HarmonicSpec {
  /** Engine order: 1 = crank rotation, cylinders/2 = firing frequency. */
  order: number;
  gainLow: number;
  gainHigh: number;
}

export interface EngineAudioProfile {
  /** Firing angles in crank degrees (0-720) grouped by exhaust bank. */
  firingBanks: number[][];
  /** Relative level of each bank (bank imbalance creates lope). */
  bankGains: number[];
  /** Pulse body decay in milliseconds. */
  pulseDecayMs: number;
  /** 0..1 amount of broadband noise in each pulse. */
  pulseNoise: number;
  /** Per-cylinder level variation, 0..0.3. */
  cylinderVariance: number;
  /** Firing-timing jitter in crank degrees at idle. */
  idleJitterDeg: number;
  resonators: ResonatorSpec[];
  /** Detune applied to the second bank's resonators (e.g. 0.06 = 6 %). */
  bankDetune: number;
  harmonics: HarmonicSpec[];
  exhaust: {
    /** Saturation drive at full throttle. */
    drive: number;
    /** Peak frequency of the exhaust rasp. */
    raspFreq: number;
    raspGain: number;
    /** Low-pass cut-off at idle and the extra cut-off added at full load/redline. */
    lowpassBase: number;
    lowpassRange: number;
    level: number;
  };
  intake: { centerFreq: number; q: number; level: number };
  /** Mechanical body (low-passed pulses). */
  bodyLevel: number;
  /** Overrun pops and crackles 0..1. */
  crackle: number;
  /** Induction voice levels (used only when the engine has forced induction). */
  induction: {
    whineLevel: number;
    /** Turbo: whine frequency at full boost. Supercharger: whine frequency per crank Hz. */
    whineFreq: number;
    hissLevel: number;
    blowOffLevel: number;
    /** Compressor surge flutter instead of a clean blow-off valve release. */
    flutter: boolean;
  };
}

export interface VehicleProfile {
  id: string;
  displayName: string;
  /** Short configuration label, e.g. "4.4 L twin-turbo V8". */
  engineLabel: string;
  layout: string;
  cylinders: number;
  induction: InductionType;
  transmission: TransmissionKind;
  rpm: {
    min: number;
    idle: number;
    /** Start of the red zone on the tachometer. */
    redline: number;
    /** Fuel cut. */
    limiter: number;
    /** Tachometer scale maximum. */
    max: number;
    /** Launch-control hold speed. */
    launch: number;
  };
  gearRatios: number[];
  finalDrive: number;
  /** Rolling circumference of the driven tyre, metres. */
  wheelCircumference: number;
  shift: {
    /** Upshift RPM at light and full throttle. */
    upLight: number;
    upFull: number;
    /** Downshift when RPM falls below this. */
    down: number;
    /** Kickdown allowed while the lower gear stays below this RPM. */
    kickdownMaxRpm: number;
    /** Time of a single shift. */
    durationMs: number;
    /** Minimum time between automatic shifts. */
    minDwellMs: number;
  };
  response: {
    /** RPM time constant while rising / falling freely (seconds). */
    riseTime: number;
    fallTime: number;
    /** Pedal-to-throttle ramp time for a full press (seconds). */
    throttleRiseTime: number;
    /** Exponent on throttle → torque (1 linear, <1 aggressive). */
    throttleCurve: number;
    /** Engine braking deceleration scale (m/s² at redline in first gear). */
    engineBraking: number;
    /** Approximate 0-100 km/h time used to scale virtual acceleration. */
    zeroToHundred: number;
  };
  /** Forced-induction behaviour; ignored for naturally aspirated engines. */
  boost: {
    maxBar: number;
    /** RPM where boost becomes available. */
    thresholdRpm: number;
    /** Spool time constant, seconds. */
    spoolTime: number;
  };
  audio: EngineAudioProfile;
  ui: {
    accent: string;
    accentSoft: string;
    /** Optional licensed photograph path (relative to public/). */
    image?: string;
    imageCredit?: string;
  };
}

export type EngineStatus = 'off' | 'cranking' | 'running' | 'stopping';

export type SimEvent =
  | { type: 'shift'; direction: 'up' | 'down'; from: number; to: number; load: number }
  | { type: 'blowoff'; boost: number }
  | { type: 'limiter' }
  | { type: 'start' }
  | { type: 'stop' };

export interface SimulationState {
  vehicleId: string;
  mode: SimulationMode;
  shiftControl: ShiftControl;
  demoDrive: DemoDrive;
  status: EngineStatus;
  rpm: number;
  /** 0..1 position between idle and limiter. */
  rpmNorm: number;
  /** Pedal input after ramping (0..1). */
  throttle: number;
  /** Engine load 0..1 used by audio. */
  load: number;
  /** Fuel delivery 0..1 (0 during cranking pre-fire, limiter cut, shift cut). */
  fuel: number;
  gear: number;
  gearCount: number;
  shifting: boolean;
  /** Vehicle speed in m/s. Virtual in demo, estimated from GPS in driving mode. */
  speed: number;
  speedSource: 'virtual' | 'gps' | 'none';
  /** 0..1 normalised boost. */
  boost: number;
  limiterActive: boolean;
  /** 0..1 overrun intensity (closed throttle, high RPM). */
  overrun: number;
  /** Simulated coolant temperature °C. */
  temperature: number;
  launchActive: boolean;
}
