/**
 * AudioWorklet source for the combustion voice.
 *
 * Instead of sweeping one oscillator, this synthesises the engine the way it is
 * physically produced: a train of exhaust pulses, one per cylinder firing, at the
 * real firing angles of the engine layout. Each pulse excites a small bank of
 * band-pass resonators (the exhaust pipes), separately per cylinder bank.
 * Uneven per-bank firing, cylinder-to-cylinder variance and timing jitter give
 * the sound its organic, non-synthetic character; overrun adds random pops.
 *
 * Output 0: resonated exhaust pulses. Output 1: raw low-frequency body.
 * It is kept as a string and loaded through a Blob URL so it ships inside the
 * main bundle and cannot fail on an asset path.
 */
export const ENGINE_VOICE_PROCESSOR = 'ym-engine-voice';

export const engineVoiceWorkletSource = /* js */ `
class EngineVoice extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 14000, automationRate: 'k-rate' },
      { name: 'fuel', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'overrun', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.cfg = null;
    this.alive = true;
    this.phase = 0;
    this.idx = 0;
    this.nextAngle = 0;
    this.env = [0, 0];
    this.pop = 0;
    this.popDecay = 0;
    this.bodyZ = 0;
    this.bodyHp = 0;
    this.agc = 1;
    this.seed = 22222;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === 'config') this.configure(m.config);
      if (m && m.type === 'dispose') this.alive = false;
    };
  }

  rand() {
    // xorshift — deterministic, allocation-free noise
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  configure(c) {
    const banks = c.bankGains.length;
    this.cfg = c;
    this.env = new Array(banks).fill(0);
    this.variance = c.events.map(() => (this.rand() * 2 - 1) * c.cylinderVariance);
    this.res = [];
    for (let b = 0; b < banks; b++) {
      this.res.push(c.resonators.map((r) => ({ spec: r, b0: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 })));
    }
    this.decay = Math.exp(-1 / ((c.pulseDecayMs / 1000) * sampleRate));
    this.popDecay = Math.exp(-1 / (0.004 * sampleRate));
    this.idx = 0;
    this.phase = 0;
    this.nextAngle = c.events[0].angle;
  }

  updateFilters(rpm) {
    const c = this.cfg;
    const fire = Math.max(1, (rpm / 60) * (c.cylinders / 2));
    const fireIdle = (c.idleRpm / 60) * (c.cylinders / 2);
    const ratio = fire / fireIdle;
    const nyq = sampleRate * 0.45;
    for (let b = 0; b < this.res.length; b++) {
      const detune = b === 1 ? 1 + c.bankDetune : 1;
      for (const r of this.res[b]) {
        const s = r.spec;
        const fc = Math.min(nyq, Math.max(20, s.freq * (1 + s.track * (ratio - 1)) * detune));
        const w0 = (2 * Math.PI * fc) / sampleRate;
        const alpha = Math.sin(w0) / (2 * s.q);
        const a0 = 1 + alpha;
        r.b0 = (alpha / a0) * s.gain;
        r.a1 = (-2 * Math.cos(w0)) / a0;
        r.a2 = (1 - alpha) / a0;
      }
    }
  }

  fire(rpmNorm, fuel, load, overrun, fireHz) {
    const c = this.cfg;
    const ev = c.events[this.idx];
    let amp = c.bankGains[ev.bank] * (1 + this.variance[this.idx]);
    if (fuel < 0.5) {
      // No combustion: only compression / pumping pulses.
      amp *= 0.14;
    } else {
      amp *= 0.3 + 0.7 * load;
      if (overrun > 0.1) amp *= 0.55;
    }
    // Pulse energy normalisation so high RPM doesn't simply get louder.
    amp *= 1 / (1 + fireHz / 420);
    this.env[ev.bank] = Math.max(this.env[ev.bank] * 0.4, amp);
    if (overrun > 0.12 && c.crackle > 0 && this.rand() < c.crackle * overrun * 0.11) {
      this.pop = 0.35 + this.rand() * 0.9 * c.crackle;
    }
    // Jitter the next firing angle (more at idle, nearly none at high RPM).
    this.idx++;
    let base = 0;
    if (this.idx >= c.events.length) {
      this.idx = 0;
      this.phase -= 720;
    }
    const jitter = (this.rand() * 2 - 1) * c.idleJitterDeg * (1 - 0.85 * rpmNorm);
    this.nextAngle = base + c.events[this.idx].angle + jitter;
  }

  process(_inputs, outputs, params) {
    const out0 = outputs[0][0];
    const out1 = outputs[1] ? outputs[1][0] : null;
    if (!this.cfg) return this.alive;
    const c = this.cfg;
    const rpm = params.rpm[0];
    const fuel = params.fuel[0];
    const load = params.load[0];
    const overrun = params.overrun[0];
    const rpmNorm = Math.min(1, Math.max(0, (rpm - c.idleRpm) / (c.limiterRpm - c.idleRpm)));
    const fireHz = (rpm / 60) * (c.cylinders / 2);
    const degPerSample = (rpm * 6) / sampleRate;
    this.updateFilters(rpm);
    const noise = c.pulseNoise;
    const banks = this.res.length;
    const bodyK = 1 - Math.exp((-2 * Math.PI * 160) / sampleRate);
    const bodyHpK = 1 - Math.exp((-2 * Math.PI * 28) / sampleRate);
    // Loudness normalisation: slow gain that steers each voice toward a level set
    // by load, so profiles and RPM ranges sit at comparable loudness while throttle
    // on/off contrast is preserved (pulse amplitudes still react instantly).
    const target = 0.05 * (0.45 + 0.55 * load) * (fuel < 0.5 ? 0.6 : 1);
    let energy = 0;
    const agc = this.agc;

    for (let i = 0; i < out0.length; i++) {
      if (degPerSample > 0) {
        this.phase += degPerSample;
        let guard = 0;
        while (this.phase >= this.nextAngle && guard++ < 24) this.fire(rpmNorm, fuel, load, overrun, fireHz);
      }
      let sum = 0;
      let exSum = 0;
      for (let b = 0; b < banks; b++) {
        const e = this.env[b];
        if (e < 1e-6 && this.res[b][0].y1 === 0) continue;
        this.env[b] = e * this.decay;
        const ex = e * (1 - noise + noise * (this.rand() * 2 - 1));
        exSum += ex;
        const rs = this.res[b];
        for (let k = 0; k < rs.length; k++) {
          const r = rs[k];
          const y = r.b0 * ex - r.b0 * r.x2 - r.a1 * r.y1 - r.a2 * r.y2;
          r.x2 = r.x1; r.x1 = ex; r.y2 = r.y1;
          r.y1 = Math.abs(y) < 1e-12 ? 0 : y;
          sum += y;
        }
      }
      let popSig = 0;
      if (this.pop > 1e-4) {
        popSig = this.pop * (this.rand() * 2 - 1);
        this.pop *= this.popDecay;
      }
      this.bodyZ += bodyK * (exSum - this.bodyZ);
      // DC blocker: pulses are unipolar, so remove the offset before it eats headroom.
      this.bodyHp += bodyHpK * (this.bodyZ - this.bodyHp);
      const res = sum * 2.2;
      energy += res * res;
      out0[i] = res * agc + popSig;
      if (out1) out1[i] = (this.bodyZ - this.bodyHp) * 1.6 * agc + popSig * 0.3;
    }
    const rms = Math.sqrt(energy / out0.length);
    if (rms > 1e-4 && rpm > 300) {
      const want = Math.min(4, Math.max(0.25, target / rms));
      // ~0.6 s time constant per 128-sample block
      const k = 1 - Math.exp(-out0.length / (0.6 * sampleRate));
      this.agc += (want - this.agc) * k;
    }
    return this.alive;
  }
}
registerProcessor('${'ym-engine-voice'}', EngineVoice);
`;
