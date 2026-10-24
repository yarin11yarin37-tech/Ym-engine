import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/features/audio/AudioEngine';
import { EngineSimulator } from '../src/simulation/EngineSimulator';
import { getVehicle } from '../src/data/vehicles';

/** Minimal Web Audio stand-in that records lifecycle calls. */
class FakeParam {
  value = 0;
  calls = 0;
  setTargetAtTime(v: number) {
    this.value = v;
    this.calls++;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {}
  setValueCurveAtTime() {}
}

class FakeNode {
  connected = 0;
  disconnected = false;
  constructor(public ctx: FakeContext) {
    ctx.nodes.push(this);
  }
  connect(n: FakeNode) {
    this.connected++;
    return n;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeSource extends FakeNode {
  started = 0;
  stopped = 0;
  frequency = new FakeParam();
  playbackRate = new FakeParam();
  type = 'sine';
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  constructor(ctx: FakeContext) {
    super(ctx);
    ctx.sources.push(this);
  }
  start() {
    this.started++;
  }
  stop() {
    if (this.stopped) throw new Error('already stopped');
    this.stopped++;
  }
  setPeriodicWave() {}
}

class FakeContext {
  nodes: FakeNode[] = [];
  sources: FakeSource[] = [];
  state: string = 'suspended';
  currentTime = 0;
  sampleRate = 48000;
  baseLatency = 0.01;
  destination = {};
  closed = 0;
  onstatechange: (() => void) | null = null;
  async resume() {
    if (this.state !== 'closed') this.state = 'running';
    this.onstatechange?.();
  }
  async suspend() {
    this.state = 'suspended';
    this.onstatechange?.();
  }
  async close() {
    this.closed++;
    this.state = 'closed';
  }
  createGain() {
    return Object.assign(new FakeNode(this), { gain: new FakeParam() });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(this), { type: '', frequency: new FakeParam(), Q: new FakeParam(), gain: new FakeParam() });
  }
  createDynamicsCompressor() {
    const p = () => new FakeParam();
    return Object.assign(new FakeNode(this), { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p() });
  }
  createWaveShaper() {
    return Object.assign(new FakeNode(this), { curve: null, oversample: 'none' });
  }
  createOscillator() {
    return new FakeSource(this);
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  createBuffer(_c: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data, length };
  }
  createPeriodicWave() {
    return {};
  }
}

function setup() {
  const contexts: FakeContext[] = [];
  const engine = new AudioEngine(() => {
    const c = new FakeContext();
    contexts.push(c);
    return c as unknown as AudioContext;
  });
  return { engine, contexts };
}

const profile = getVehicle('mercedes-amg-gt');

describe('Audio lifecycle', () => {
  it('builds one graph, falls back without AudioWorklet, and reaches running', async () => {
    const { engine, contexts } = setup();
    await engine.init(profile);
    expect(contexts).toHaveLength(1);
    expect(engine.status).toBe('running');
    expect(engine.voiceKind).toBe('oscillator-fallback');
  });

  it('repeated init never creates a second context or duplicate loops', async () => {
    const { engine, contexts } = setup();
    await engine.init(profile);
    const sources = contexts[0].sources.length;
    await engine.init(profile);
    await engine.init(getVehicle('porsche-911-gt3'));
    expect(contexts).toHaveLength(1);
    expect(contexts[0].sources.length).toBe(sources);
  });

  it('per-frame updates do not create nodes', async () => {
    const { engine, contexts } = setup();
    await engine.init(profile);
    const sim = new EngineSimulator(profile);
    sim.start();
    const before = contexts[0].nodes.length;
    for (let i = 0; i < 300; i++) {
      sim.step(1 / 60);
      contexts[0].currentTime += 1 / 60;
      engine.update(sim.state);
    }
    expect(contexts[0].nodes.length).toBe(before);
  });

  it('dispose stops every source, disconnects and closes; it is idempotent', async () => {
    const { engine, contexts } = setup();
    await engine.init(profile);
    const ctx = contexts[0];
    await engine.dispose();
    await engine.dispose();
    expect(ctx.closed).toBe(1);
    expect(ctx.sources.every((s) => s.stopped === 1 || s.started === 0)).toBe(true);
    expect(ctx.sources.filter((s) => s.started > 0).every((s) => s.stopped === 1)).toBe(true);
    expect(engine.status).toBe('closed');
    // Updates after dispose are ignored safely.
    const sim = new EngineSimulator(profile);
    expect(() => engine.update(sim.state)).not.toThrow();
  });

  it('can be started again after dispose with a fresh context', async () => {
    const { engine, contexts } = setup();
    await engine.init(profile);
    await engine.dispose();
    await engine.init(profile);
    expect(contexts).toHaveLength(2);
    expect(engine.status).toBe('running');
  });

  it('reports an error when Web Audio is unavailable', async () => {
    const engine = new AudioEngine(() => {
      throw new Error('no audio');
    });
    await expect(engine.init(profile)).rejects.toThrow('no audio');
    expect(engine.status).toBe('error');
    expect(engine.lastError).toBe('no audio');
  });

  it('tracks suspension and resume', async () => {
    const { engine } = setup();
    await engine.init(profile);
    await engine.suspend();
    expect(engine.status).toBe('suspended');
    expect(await engine.resume()).toBe(true);
    expect(engine.status).toBe('running');
  });

  it('master volume never exceeds unity', async () => {
    const { engine, contexts } = setup();
    await engine.init(profile);
    engine.setVolume(5);
    engine.setVolume(-1);
    engine.setVolume(1);
    const gains = contexts[0].nodes
      .map((n) => (n as unknown as { gain?: FakeParam }).gain?.value)
      .filter((v): v is number => typeof v === 'number');
    expect(Math.max(...gains)).toBeLessThanOrEqual(1);
  });
});
