import { useEffect, useRef } from 'react';
import type { VehicleProfile } from '../../simulation/types';

interface Props {
  profile: VehicleProfile;
  /** Live RPM reader (called every animation frame). Omit for a static/hero dial. */
  readRpm?: () => number;
  /** Reader for limiter state (flashes the red zone). */
  readLimiter?: () => boolean;
  /** Play the instrument startup sweep when mounted or when the profile changes. */
  sweep?: boolean;
  className?: string;
  label?: string;
  /** Draw the "rpm × 1000" unit label on the dial face. */
  unitLabel?: boolean;
}

const START = Math.PI * 0.75; // 135°
const SWEEP = Math.PI * 1.5; // 270°
const SWEEP_MS = 1500;

/** Canvas tachometer: static layer cached off-screen, only the needle redraws per frame. */
export function Tachometer({ profile, readRpm, readLimiter, sweep = true, className, label, unitLabel = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readRef = useRef(readRpm);
  const limRef = useRef(readLimiter);
  useEffect(() => {
    readRef.current = readRpm;
    limRef.current = readLimiter;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const css = getComputedStyle(document.documentElement);
    const col = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb;
    const C = {
      face: col('--c-graphite', '#15171a'),
      rim: col('--c-gunmetal', '#2b2e34'),
      tick: col('--c-steel', '#8a9099'),
      text: col('--c-warm', '#f2ede4'),
      amber: col('--c-amber', '#f0a53a'),
      accent: profile.ui.accent,
    };

    let size = 0;
    let dpr = 1;
    let staticLayer: HTMLCanvasElement | null = null;
    let lastDrawn = -1;
    const maxRpm = profile.rpm.max;
    const angleFor = (rpm: number) => START + (Math.min(Math.max(rpm, 0), maxRpm) / maxRpm) * SWEEP;

    const buildStatic = () => {
      const rect = canvas.getBoundingClientRect();
      size = Math.max(120, Math.min(rect.width, rect.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      const layer = document.createElement('canvas');
      layer.width = canvas.width;
      layer.height = canvas.height;
      const g = layer.getContext('2d');
      if (!g) return;
      g.scale(dpr, dpr);
      const c = size / 2;
      const R = size / 2 - 4;

      // Face
      const face = g.createRadialGradient(c, c * 0.8, R * 0.1, c, c, R);
      face.addColorStop(0, '#1b1d21');
      face.addColorStop(1, C.face);
      g.fillStyle = face;
      g.beginPath();
      g.arc(c, c, R, 0, Math.PI * 2);
      g.fill();
      // Machined bezel
      const bezel = g.createLinearGradient(0, 0, size, size);
      bezel.addColorStop(0, '#5d626b');
      bezel.addColorStop(0.45, '#23262b');
      bezel.addColorStop(1, '#4a4f57');
      g.lineWidth = Math.max(2, size * 0.012);
      g.strokeStyle = bezel;
      g.stroke();

      // Track
      const trackR = R * 0.86;
      g.lineCap = 'butt';
      g.lineWidth = size * 0.022;
      g.strokeStyle = C.rim;
      g.beginPath();
      g.arc(c, c, trackR, START, START + SWEEP);
      g.stroke();
      // Red zone
      g.strokeStyle = C.accent;
      g.globalAlpha = 0.9;
      g.beginPath();
      g.arc(c, c, trackR, angleFor(profile.rpm.redline), START + SWEEP);
      g.stroke();
      g.globalAlpha = 1;

      // Ticks and numerals
      const step = 250;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `600 ${Math.round(size * 0.058)}px ${css.getPropertyValue('--font-display') || 'sans-serif'}`;
      for (let r = 0; r <= maxRpm; r += step) {
        const a = angleFor(r);
        const major = r % 1000 === 0;
        const half = r % 500 === 0;
        const outer = R * 0.79;
        const inner = outer - (major ? size * 0.06 : half ? size * 0.035 : size * 0.02);
        g.strokeStyle = r >= profile.rpm.redline ? C.accent : major ? C.text : C.tick;
        g.lineWidth = major ? size * 0.009 : size * 0.004;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
        g.lineTo(c + Math.cos(a) * outer, c + Math.sin(a) * outer);
        g.stroke();
        if (major) {
          const tr = R * 0.6;
          g.fillStyle = r >= profile.rpm.redline ? C.accent : C.text;
          g.fillText(String(r / 1000), c + Math.cos(a) * tr, c + Math.sin(a) * tr);
        }
      }
      if (unitLabel) {
        g.fillStyle = C.tick;
        g.font = `500 ${Math.round(size * 0.034)}px ${css.getPropertyValue('--font-ui') || 'sans-serif'}`;
        g.fillText('rpm × 1000', c, c + R * 0.42);
      }
      staticLayer = layer;
      lastDrawn = -1;
    };

    const draw = (rpm: number, limiter: boolean) => {
      if (!staticLayer) return;
      const c = size / 2;
      const R = size / 2 - 4;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(staticLayer, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const a = angleFor(rpm);

      // Lit segment along the track
      ctx.lineCap = 'butt';
      ctx.lineWidth = size * 0.022;
      ctx.strokeStyle = rpm >= profile.rpm.redline ? C.accent : C.amber;
      ctx.globalAlpha = limiter ? 0.55 + 0.45 * Math.round((performance.now() / 60) % 2) : 0.95;
      ctx.beginPath();
      ctx.arc(c, c, R * 0.86, START, a);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Needle
      const tipR = R * 0.82;
      const tailR = R * 0.12;
      ctx.lineCap = 'round';
      ctx.strokeStyle = C.text;
      ctx.lineWidth = size * 0.012;
      ctx.beginPath();
      ctx.moveTo(c - Math.cos(a) * tailR, c - Math.sin(a) * tailR);
      ctx.lineTo(c + Math.cos(a) * tipR * 0.7, c + Math.sin(a) * tipR * 0.7);
      ctx.stroke();
      ctx.strokeStyle = C.amber;
      ctx.lineWidth = size * 0.009;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * tipR * 0.7, c + Math.sin(a) * tipR * 0.7);
      ctx.lineTo(c + Math.cos(a) * tipR, c + Math.sin(a) * tipR);
      ctx.stroke();
      // Hub
      ctx.fillStyle = '#0a0b0d';
      ctx.beginPath();
      ctx.arc(c, c, size * 0.045, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#3c4047';
      ctx.lineWidth = size * 0.006;
      ctx.stroke();
    };

    buildStatic();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => buildStatic()) : null;
    ro?.observe(canvas);

    const t0 = performance.now();
    let raf = 0;
    let shown = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const el = t - t0;
      let target = readRef.current ? readRef.current() : 0;
      if (sweep && !reduceMotion && el < SWEEP_MS) {
        // Instrument startup: sweep to full scale and back.
        const k = el / SWEEP_MS;
        target = Math.max(target, Math.sin(k * Math.PI) * maxRpm);
        shown = target;
      } else {
        // Light needle damping so readings never look jittery.
        shown += (target - shown) * 0.5;
      }
      const lim = limRef.current ? limRef.current() : false;
      if (Math.abs(shown - lastDrawn) < 2 && !lim) return;
      lastDrawn = shown;
      draw(shown, lim);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [profile, sweep, unitLabel]);

  return <canvas ref={canvasRef} className={className} role="img" aria-label={label ?? `Tachometer, ${profile.displayName}`} />;
}
