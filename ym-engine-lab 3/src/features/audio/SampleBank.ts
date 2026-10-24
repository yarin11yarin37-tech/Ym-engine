/**
 * Optional recorded-engine layer. Every loop runs continuously from start; only
 * gains and playback rates move, so crossfades are click-free and no nodes are
 * created per frame.
 */
import { rpmCrossfadeWeights, type VehicleSampleSet } from './assetManifest';
import { setParam } from './params';
import { baseUrl } from '../../utils/env';

interface Voice {
  rpm: number;
  on?: { src: AudioBufferSourceNode; gain: GainNode };
  off?: { src: AudioBufferSourceNode; gain: GainNode };
}

export class SampleBank {
  private voices: Voice[] = [];
  private disposed = false;
  readonly output: GainNode;
  /** Diagnostics: files that failed to load. */
  readonly failures: string[] = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly set: VehicleSampleSet,
  ) {
    this.output = ctx.createGain();
    this.output.gain.value = set.gain;
  }

  get active(): boolean {
    return this.voices.some((v) => v.on || v.off);
  }

  async load(): Promise<void> {
    const decode = async (path: string): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(baseUrl() + path.replace(/^\//, ''));
        if (!res.ok) throw new Error(String(res.status));
        return await this.ctx.decodeAudioData(await res.arrayBuffer());
      } catch {
        this.failures.push(path);
        return null;
      }
    };
    const layers = [...this.set.layers].sort((a, b) => a.rpm - b.rpm);
    const loaded = await Promise.all(
      layers.map(async (l) => ({ rpm: l.rpm, on: l.onLoad ? await decode(l.onLoad) : null, off: l.offLoad ? await decode(l.offLoad) : null })),
    );
    if (this.disposed) return;
    const make = (buf: AudioBuffer | null) => {
      if (!buf) return undefined;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(this.output);
      src.start();
      return { src, gain };
    };
    this.voices = loaded.filter((l) => l.on || l.off).map((l) => ({ rpm: l.rpm, on: make(l.on), off: make(l.off) }));
  }

  update(rpm: number, load: number, running: boolean): void {
    if (!this.voices.length) return;
    const now = this.ctx.currentTime;
    const weights = rpmCrossfadeWeights(this.voices.map((v) => v.rpm), rpm);
    const onW = Math.sqrt(Math.min(1, Math.max(0, load)));
    const offW = Math.sqrt(1 - Math.min(1, Math.max(0, load)));
    this.voices.forEach((v, i) => {
      const rate = Math.min(1.5, Math.max(0.6, rpm / v.rpm));
      const w = running ? weights[i] : 0;
      for (const [layer, lw] of [
        [v.on, v.off ? onW : 1],
        [v.off, v.on ? offW : 1],
      ] as const) {
        if (!layer) continue;
        setParam(layer.src.playbackRate, rate, now, 0.03);
        setParam(layer.gain.gain, w * lw, now, 0.04);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const v of this.voices) {
      for (const layer of [v.on, v.off]) {
        if (!layer) continue;
        try {
          layer.src.stop();
        } catch {
          /* already stopped */
        }
        layer.src.disconnect();
        layer.gain.disconnect();
      }
    }
    this.voices = [];
    this.output.disconnect();
  }
}
