/**
 * Real-time layered engine audio (Web Audio API).
 *
 *   A  ENGINE BASE   combustion pulse train → body low-pass
 *   B  HARMONICS     engine-order oscillators, levels vary with RPM
 *   C  INTAKE        filtered noise, opens with throttle and load
 *   D  EXHAUST       resonated pulses → saturation → rasp EQ → dynamic low-pass
 *   E  INDUCTION     turbo whine + hiss + blow-off / supercharger whine
 *   F  GEAR SHIFTS   torque-cut dip, DCT "crack", downshift thump
 *   G  DECELERATION  overrun: closing filters, quieter pulses, pops (in the voice)
 *   H  IDLE          timing jitter + RPM wobble from the simulator
 *
 * The graph is built exactly once per AudioContext. Per frame only AudioParams
 * move (setTargetAtTime). One-shot sounds are created only on discrete events.
 * Master chain: engine fade → gain staging → brick-wall-ish limiter → volume.
 */
import { ENGINE_VOICE_PROCESSOR, engineVoiceWorkletSource } from './engineVoiceWorklet';
import { getSampleSet } from './assetManifest';
import { SampleBank } from './SampleBank';
import { makeNoiseBuffer, makeSaturationCurve, resetParam, setParam } from './params';
import { flattenFiring } from '../../simulation/firing';
import type { SimEvent, SimulationState, VehicleProfile } from '../../simulation/types';
import { clamp, lerp } from '../../utils/math';

export type AudioStatus = 'idle' | 'starting' | 'running' | 'suspended' | 'error' | 'closed';
export type VoiceKind = 'worklet' | 'oscillator-fallback' | 'none';

export type AudioContextFactory = () => AudioContext;

/** Exhaust valve / drive mode: how loud, raspy and poppy the exhaust is. */
export type ExhaustMode = 'comfort' | 'sport' | 'track';

const EXHAUST_MODES: Record<ExhaustMode, { level: number; drive: number; rasp: number; crackle: number; body: number }> = {
  comfort: { level: 0.72, drive: 0.65, rasp: 0.5, crackle: 0.25, body: 0.85 },
  sport: { level: 1, drive: 1, rasp: 1, crackle: 1, body: 1 },
  track: { level: 1.12, drive: 1.4, rasp: 1.45, crackle: 1.7, body: 1.1 },
};

const defaultFactory: AudioContextFactory = () => {
  const Ctor: typeof AudioContext | undefined =
    typeof window !== 'undefined'
      ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!Ctor) throw new Error('Web Audio is not supported in this browser.');
  return new Ctor({ latencyHint: 'interactive' });
};

interface Graph {
  engineFade: GainNode;
  staging: GainNode;
  limiter: DynamicsCompressorNode;
  volume: GainNode;
  // A / D
  voice: AudioWorkletNode | null;
  fallbackOsc: OscillatorNode | null;
  fallbackGain: GainNode | null;
  bodyLP: BiquadFilterNode;
  bodyGain: GainNode;
  exHP: BiquadFilterNode;
  exDrive: GainNode;
  shaper: WaveShaperNode;
  rasp: BiquadFilterNode;
  exLP: BiquadFilterNode;
  shiftDip: GainNode;
  exGain: GainNode;
  // B
  harmonics: { osc: OscillatorNode; gain: GainNode }[];
  // C / E
  noise: AudioBufferSourceNode;
  noiseBuffer: AudioBuffer;
  intakeBP: BiquadFilterNode;
  intakeGain: GainNode;
  hissBP: BiquadFilterNode;
  hissGain: GainNode;
  whineOsc: OscillatorNode;
  whineLP: BiquadFilterNode;
  whineGain: GainNode;
  // F / one-shots
  fxBus: GainNode;
  // Samples
  sampleBus: GainNode;
}

const MAX_HARMONICS = 4;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private g: Graph | null = null;
  private profile: VehicleProfile | null = null;
  private samples: SampleBank | null = null;
  private _status: AudioStatus = 'idle';
  private _voiceKind: VoiceKind = 'none';
  private volume = 0.8;
  private exhaust = EXHAUST_MODES.sport;
  private exhaustMode: ExhaustMode = 'sport';
  private listeners = new Set<(s: AudioStatus) => void>();
  private oneShots = new Set<AudioScheduledSourceNode>();
  private initPromise: Promise<void> | null = null;
  lastError: string | null = null;

  constructor(private readonly factory: AudioContextFactory = defaultFactory) {}

  // ───────────────────────── lifecycle ─────────────────────────

  get status(): AudioStatus {
    return this._status;
  }
  get voiceKind(): VoiceKind {
    return this._voiceKind;
  }
  get context(): AudioContext | null {
    return this.ctx;
  }
  get sampleInfo(): { active: boolean; failures: string[] } {
    return { active: !!this.samples?.active, failures: this.samples?.failures ?? [] };
  }

  onStatus(fn: (s: AudioStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: AudioStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.listeners.forEach((fn) => fn(s));
  }

  /**
   * Must be called from a user gesture (click / tap). Creates the context
   * synchronously inside the gesture, then finishes async setup. Safe to call
   * repeatedly — it never builds a second graph.
   */
  init(profile: VehicleProfile): Promise<void> {
    if (this.initPromise && this._status !== 'error' && this._status !== 'closed') {
      this.setVehicle(profile);
      return this.resume().then(() => undefined);
    }
    this.profile = profile;
    this.setStatus('starting');
    let ctx: AudioContext;
    try {
      ctx = this.factory();
    } catch (e) {
      this.fail(e);
      return Promise.reject(e);
    }
    this.ctx = ctx;
    // Kick off resume inside the gesture.
    const resumed = ctx.state === 'suspended' ? ctx.resume().catch(() => undefined) : Promise.resolve();
    ctx.onstatechange = () => this.syncStatus();

    this.initPromise = (async () => {
      try {
        this.g = this.buildGraph(ctx);
        await this.attachVoice(ctx);
        this.applyProfile(profile);
        await resumed;
        this.syncStatus();
      } catch (e) {
        this.fail(e);
        throw e;
      }
    })();
    return this.initPromise;
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.setStatus('error');
  }

  private syncStatus(): void {
    if (!this.ctx) return;
    const st = this.ctx.state as string;
    if (st === 'running') this.setStatus('running');
    else if (st === 'closed') this.setStatus('closed');
    else this.setStatus('suspended'); // 'suspended' or Safari's 'interrupted'
  }

  async resume(): Promise<boolean> {
    if (!this.ctx || this.ctx.state === 'closed') return false;
    try {
      await this.ctx.resume();
    } catch {
      /* needs a gesture */
    }
    this.syncStatus();
    return this.ctx.state === 'running';
  }

  async suspend(): Promise<void> {
    if (!this.ctx || this.ctx.state !== 'running') return;
    try {
      await this.ctx.suspend();
    } catch {
      /* ignore */
    }
    this.syncStatus();
  }

  /** Stops every source, disconnects the graph and closes the context. Idempotent. */
  async dispose(): Promise<void> {
    const ctx = this.ctx;
    const g = this.g;
    this.ctx = null;
    this.g = null;
    this.initPromise = null;
    this._voiceKind = 'none';
    this.samples?.dispose();
    this.samples = null;
    this.oneShots.forEach((n) => {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    });
    this.oneShots.clear();
    if (g) {
      const stop = (n: AudioScheduledSourceNode | null) => {
        if (!n) return;
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      };
      stop(g.noise);
      stop(g.whineOsc);
      stop(g.fallbackOsc);
      g.harmonics.forEach((h) => stop(h.osc));
      if (g.voice) {
        g.voice.port.postMessage({ type: 'dispose' });
        g.voice.port.onmessage = null;
      }
      Object.values(g).forEach((v) => {
        if (v && typeof (v as AudioNode).disconnect === 'function') {
          try {
            (v as AudioNode).disconnect();
          } catch {
            /* ignore */
          }
        }
      });
      g.harmonics.forEach((h) => {
        h.osc.disconnect();
        h.gain.disconnect();
      });
    }
    if (ctx) {
      ctx.onstatechange = null;
      if (ctx.state !== 'closed') {
        try {
          await ctx.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.setStatus('closed');
  }

  // ───────────────────────── graph ─────────────────────────

  private buildGraph(ctx: AudioContext): Graph {
    const gain = (v: number) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    const filter = (type: BiquadFilterType, freq: number, q = 0.707) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };

    const engineFade = gain(0);
    const staging = gain(0.62);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -7;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const volume = gain(this.volume * this.volume);
    engineFade.connect(staging).connect(limiter).connect(volume).connect(ctx.destination);

    // A — body
    const bodyLP = filter('lowpass', 180, 0.9);
    const bodyGain = gain(0);
    bodyLP.connect(bodyGain).connect(engineFade);

    // D — exhaust chain
    const exHP = filter('highpass', 45, 0.6);
    const exDrive = gain(1);
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSaturationCurve();
    shaper.oversample = '2x';
    const rasp = filter('peaking', 1200, 1.1);
    rasp.gain.value = 0;
    const exLP = filter('lowpass', 1200, 0.8);
    const shiftDip = gain(1);
    const exGain = gain(0);
    exHP.connect(exDrive).connect(shaper).connect(rasp).connect(exLP).connect(shiftDip).connect(exGain).connect(engineFade);

    // B — harmonics
    const harmonics = Array.from({ length: MAX_HARMONICS }, () => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 40;
      const g = gain(0);
      osc.connect(g).connect(engineFade);
      osc.start();
      return { osc, gain: g };
    });

    // C / E — shared noise source
    const noiseBuffer = makeNoiseBuffer(ctx);
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const intakeBP = filter('bandpass', 600, 1.4);
    const intakeGain = gain(0);
    noise.connect(intakeBP).connect(intakeGain).connect(engineFade);
    const hissBP = filter('bandpass', 5200, 1.6);
    const hissGain = gain(0);
    noise.connect(hissBP).connect(hissGain).connect(engineFade);
    noise.start();

    const whineOsc = ctx.createOscillator();
    whineOsc.type = 'sine';
    whineOsc.frequency.value = 1000;
    const whineLP = filter('lowpass', 9000, 0.7);
    const whineGain = gain(0);
    whineOsc.connect(whineLP).connect(whineGain).connect(engineFade);
    whineOsc.start();

    const fxBus = gain(1);
    fxBus.connect(engineFade);
    const sampleBus = gain(1);
    sampleBus.connect(engineFade);

    return {
      engineFade, staging, limiter, volume,
      voice: null, fallbackOsc: null, fallbackGain: null,
      bodyLP, bodyGain, exHP, exDrive, shaper, rasp, exLP, shiftDip, exGain,
      harmonics, noise, noiseBuffer, intakeBP, intakeGain, hissBP, hissGain,
      whineOsc, whineLP, whineGain, fxBus, sampleBus,
    };
  }

  /** Prefer the AudioWorklet pulse synthesiser; fall back to an oscillator voice. */
  private async attachVoice(ctx: AudioContext): Promise<void> {
    const g = this.g!;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined' && typeof Blob !== 'undefined') {
      let url: string | null = null;
      try {
        url = URL.createObjectURL(new Blob([engineVoiceWorkletSource], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        if (this.ctx !== ctx) return; // disposed meanwhile
        const voice = new AudioWorkletNode(ctx, ENGINE_VOICE_PROCESSOR, {
          numberOfInputs: 0,
          numberOfOutputs: 2,
          outputChannelCount: [1, 1],
        });
        voice.connect(g.exHP, 0);
        voice.connect(g.bodyLP, 1);
        g.voice = voice;
        this._voiceKind = 'worklet';
        return;
      } catch (e) {
        this.lastError = `Worklet unavailable, using fallback voice (${e instanceof Error ? e.message : e})`;
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    }
    // Fallback: a harmonic-rich periodic wave at the firing frequency.
    const osc = ctx.createOscillator();
    const fg = ctx.createGain();
    fg.gain.value = 0;
    osc.connect(fg);
    fg.connect(g.exHP);
    fg.connect(g.bodyLP);
    osc.start();
    g.fallbackOsc = osc;
    g.fallbackGain = fg;
    this._voiceKind = 'oscillator-fallback';
  }

  // ───────────────────────── vehicle ─────────────────────────

  setVehicle(profile: VehicleProfile): void {
    this.profile = profile;
    if (this.g && this.ctx) this.applyProfile(profile);
  }

  private applyProfile(p: VehicleProfile): void {
    const g = this.g;
    const ctx = this.ctx;
    if (!g || !ctx) return;
    const a = p.audio;
    if (g.voice) {
      g.voice.port.postMessage({
        type: 'config',
        config: {
          events: flattenFiring(a.firingBanks),
          bankGains: a.bankGains,
          pulseDecayMs: a.pulseDecayMs,
          pulseNoise: a.pulseNoise,
          cylinderVariance: a.cylinderVariance,
          idleJitterDeg: a.idleJitterDeg,
          resonators: a.resonators,
          bankDetune: a.bankDetune,
          cylinders: p.cylinders,
          idleRpm: p.rpm.idle,
          limiterRpm: p.rpm.limiter,
          crackle: Math.min(1.5, a.crackle * this.exhaust.crackle),
        },
      });
    }
    if (g.fallbackOsc) {
      // Firing-frequency fundamental with decaying harmonics and a strong 2nd.
      const n = 16;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let k = 1; k < n; k++) imag[k] = (k === 2 ? 0.7 : 1) / Math.pow(k, 1.1);
      g.fallbackOsc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    }
    g.whineOsc.type = p.induction === 'supercharger' ? 'sawtooth' : 'sine';
    g.whineLP.frequency.value = p.induction === 'supercharger' ? 5200 : 12000;
    g.intakeBP.Q.value = a.intake.q;

    // Swap recorded layer if this profile has one.
    this.samples?.dispose();
    this.samples = null;
    const set = getSampleSet(p.id);
    if (set) {
      const bank = new SampleBank(ctx, set);
      bank.output.connect(g.sampleBus);
      this.samples = bank;
      bank.load().catch(() => undefined);
    }
  }

  /** Switch exhaust character. Pops are re-sent to the voice; levels follow on the next frame. */
  setExhaustMode(mode: ExhaustMode): void {
    if (!(mode in EXHAUST_MODES)) return;
    this.exhaustMode = mode;
    this.exhaust = EXHAUST_MODES[mode];
    if (this.g && this.ctx && this.profile) this.applyProfile(this.profile);
  }

  get currentExhaustMode(): ExhaustMode {
    return this.exhaustMode;
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.g && this.ctx) setParam(this.g.volume.gain, this.volume * this.volume, this.ctx.currentTime, 0.05);
  }

  // ───────────────────────── per-frame update ─────────────────────────

  update(s: SimulationState): void {
    const g = this.g;
    const ctx = this.ctx;
    const p = this.profile;
    if (!g || !ctx || !p || ctx.state === 'closed') return;
    const now = ctx.currentTime;
    const a = p.audio;
    const audible = s.status !== 'off' || s.rpm > 30;
    const rpm = s.rpm;
    const n = s.rpmNorm;
    const load = clamp(s.load, 0, 1);
    const thr = clamp(s.throttle, 0, 1);
    const crank = rpm / 60;
    const fire = crank * (p.cylinders / 2);
    const sampleMix = this.samples?.active ? (getSampleSet(p.id)?.proceduralBlend ?? 0.3) : 1;

    setParam(g.engineFade.gain, audible ? 1 : 0, now, audible ? 0.02 : 0.25);

    // A/D — voice parameters
    if (g.voice) {
      const P = g.voice.parameters;
      setParam(P.get('rpm')!, rpm, now, 0.012, 1e-3);
      setParam(P.get('fuel')!, s.fuel, now, 0.004);
      setParam(P.get('load')!, load, now, 0.02);
      setParam(P.get('overrun')!, s.overrun, now, 0.03);
    } else if (g.fallbackOsc && g.fallbackGain) {
      setParam(g.fallbackOsc.frequency, Math.max(1, fire), now, 0.015);
      setParam(g.fallbackGain.gain, rpm > 30 ? 0.12 * (0.4 + 0.6 * load) * s.fuel + 0.02 : 0, now, 0.02);
    }

    // A — body
    setParam(g.bodyLP.frequency, 130 + 300 * n, now, 0.04);
    const ex = this.exhaust;
    setParam(g.bodyGain.gain, a.bodyLevel * ex.body * (0.65 + 0.35 * load) * (1 - 0.45 * n) * sampleMix, now, 0.04);

    // D — exhaust
    const drive = 1 + a.exhaust.drive * ex.drive * (0.12 + 0.88 * load);
    setParam(g.exDrive.gain, drive, now, 0.03);
    setParam(g.rasp.frequency, a.exhaust.raspFreq * (0.8 + 0.4 * n), now, 0.05);
    setParam(g.rasp.gain, a.exhaust.raspGain * ex.rasp * load * (0.3 + 0.7 * n), now, 0.05);
    const openness = 0.22 * n + 0.78 * load * Math.sqrt(n) + 0.15 * s.overrun;
    setParam(g.exLP.frequency, a.exhaust.lowpassBase + a.exhaust.lowpassRange * clamp(openness, 0, 1), now, 0.04);
    const exLevel = (a.exhaust.level * ex.level * (0.5 + 0.5 * load)) / (1 + 0.35 * (drive - 1));
    setParam(g.exGain.gain, exLevel * sampleMix, now, 0.03);

    // B — harmonics
    g.harmonics.forEach((h, i) => {
      const spec = a.harmonics[i];
      if (!spec || rpm < 30) {
        setParam(h.gain.gain, 0, now, 0.05);
        return;
      }
      setParam(h.osc.frequency, Math.max(1, crank * spec.order), now, 0.015);
      setParam(h.gain.gain, lerp(spec.gainLow, spec.gainHigh, n) * (0.45 + 0.55 * load) * s.fuel * sampleMix, now, 0.04);
    });

    // C — intake
    setParam(g.intakeBP.frequency, a.intake.centerFreq * (0.55 + 0.95 * n), now, 0.05);
    const intake = s.status === 'running' ? a.intake.level * (0.04 + thr * (0.3 + 0.7 * n)) : 0;
    setParam(g.intakeGain.gain, intake, now, 0.04);

    // E — induction
    const ind = a.induction;
    if (p.induction === 'supercharger') {
      setParam(g.whineOsc.frequency, Math.max(20, crank * ind.whineFreq), now, 0.015);
      setParam(g.whineGain.gain, ind.whineLevel * (0.25 + 0.75 * thr) * Math.pow(n, 0.8) * (s.fuel > 0.5 ? 1 : 0.4), now, 0.04);
      setParam(g.hissGain.gain, 0, now, 0.1);
    } else if (p.induction !== 'none') {
      const b = s.boost;
      setParam(g.whineOsc.frequency, 1200 + ind.whineFreq * b, now, 0.06);
      setParam(g.whineGain.gain, ind.whineLevel * Math.pow(b, 1.5), now, 0.05);
      setParam(g.hissGain.gain, ind.hissLevel * b * (0.3 + 0.7 * thr), now, 0.05);
      setParam(g.hissBP.frequency, 3800 + 2400 * b, now, 0.08);
    } else {
      setParam(g.whineGain.gain, 0, now, 0.1);
      setParam(g.hissGain.gain, 0, now, 0.1);
    }

    this.samples?.update(rpm, load, s.status === 'running' || s.status === 'cranking');
  }

  // ───────────────────────── discrete events (F, E one-shots) ─────────────────────────

  handleEvents(events: SimEvent[], s: SimulationState): void {
    if (!events.length || !this.g || !this.ctx || !this.profile) return;
    for (const ev of events) {
      if (ev.type === 'shift') this.playShift(ev.direction, ev.load);
      else if (ev.type === 'blowoff') this.playBlowOff(ev.boost);
      else if (ev.type === 'start' && s.status === 'cranking') this.playStarter();
    }
  }

  private trackOneShot(node: AudioScheduledSourceNode, cleanup: AudioNode[]): void {
    this.oneShots.add(node);
    node.onended = () => {
      this.oneShots.delete(node);
      cleanup.forEach((n) => n.disconnect());
    };
  }

  private noiseBurst(durationS: number, filterType: BiquadFilterType, freq: number, q: number, peak: number, attack = 0.002): { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } {
    const ctx = this.ctx!;
    const g = this.g!;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = g.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + attack);
    gain.gain.setTargetAtTime(0, now + attack, durationS / 4);
    src.connect(filter).connect(gain).connect(g.fxBus);
    src.start(now, Math.random() * 1.5);
    src.stop(now + durationS + 0.05);
    this.trackOneShot(src, [src, filter, gain]);
    return { src, filter, gain };
  }

  private playShift(direction: 'up' | 'down', load: number): void {
    const ctx = this.ctx!;
    const g = this.g!;
    const p = this.profile!;
    const now = ctx.currentTime;
    const dur = p.shift.durationMs / 1000;
    const dip = g.shiftDip.gain;
    dip.cancelScheduledValues(now);
    dip.setValueAtTime(dip.value, now);
    if (direction === 'up') {
      dip.linearRampToValueAtTime(0.32 + 0.3 * (1 - load), now + Math.min(0.04, dur * 0.3));
      dip.setTargetAtTime(1, now + dur * 0.75, dur * 0.35);
      if (load > 0.55 && p.transmission !== 'automatic') {
        // Ignition-cut "crack" on a loaded DCT/manual upshift.
        this.noiseBurst(0.06, 'bandpass', 650, 1.2, 0.5 * load * (0.4 + p.audio.crackle));
      }
    } else {
      dip.linearRampToValueAtTime(0.75, now + 0.02);
      dip.setTargetAtTime(1, now + 0.03, 0.05);
      this.noiseBurst(0.04, 'lowpass', 300, 0.7, 0.18);
    }
    resetParam(dip, 1);
  }

  private playBlowOff(boost: number): void {
    const p = this.profile!;
    const ind = p.audio.induction;
    if (!(ind.blowOffLevel > 0)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const level = ind.blowOffLevel * clamp(boost, 0.3, 1);
    if (ind.flutter) {
      // Compressor surge: fast amplitude chatter, darker.
      const { gain, filter } = this.noiseBurst(0.5, 'bandpass', 1500, 1.6, level, 0.004);
      const steps = 18;
      const curve = new Float32Array(steps);
      for (let i = 0; i < steps; i++) curve[i] = level * (i % 2 ? 0.15 : 1) * Math.exp(-i / 7);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueCurveAtTime(curve, now, 0.45);
      filter.frequency.setTargetAtTime(900, now, 0.2);
    } else {
      const { filter } = this.noiseBurst(0.42, 'bandpass', 3200, 1.3, level, 0.008);
      filter.frequency.setTargetAtTime(1300, now + 0.02, 0.14);
    }
  }

  private playStarter(): void {
    const ctx = this.ctx!;
    const g = this.g!;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(110, now);
    osc.frequency.linearRampToValueAtTime(165, now + 0.45);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.05, now + 0.05);
    gain.gain.setValueAtTime(0.05, now + 0.45);
    gain.gain.linearRampToValueAtTime(0, now + 0.62);
    osc.connect(lp).connect(gain).connect(g.fxBus);
    osc.start(now);
    osc.stop(now + 0.7);
    this.trackOneShot(osc, [osc, lp, gain]);
  }

  /** Number of active one-shot sources (diagnostics / tests). */
  get activeOneShots(): number {
    return this.oneShots.size;
  }
}
