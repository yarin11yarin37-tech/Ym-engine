import { useEffect, useState } from 'react';
import { GPS_STATUS_LABEL } from '../features/driving-mode/gpsTracker';
import { useController, useSnapshot } from '../hooks/useController';

function detect() {
  const w = typeof window !== 'undefined' ? window : undefined;
  return {
    audioContext: !!(w && (w.AudioContext || (w as unknown as { webkitAudioContext?: unknown }).webkitAudioContext)),
    audioWorklet: typeof AudioWorkletNode !== 'undefined',
    geolocation: typeof navigator !== 'undefined' && 'geolocation' in navigator,
    secure: !!w?.isSecureContext,
    touch: typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in (w ?? {})),
    pointer: typeof PointerEvent !== 'undefined',
    motion: typeof DeviceMotionEvent !== 'undefined',
  };
}

const yes = (b: boolean) => (b ? 'Available' : 'Not available');

/** Compatibility panel. Never shows location coordinates. */
export function Diagnostics({ onClose }: { onClose: () => void }) {
  const c = useController();
  const snap = useSnapshot();
  const [caps] = useState(detect);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 });

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const ctx = c.audio.context;
  const samples = c.audio.sampleInfo;
  const rows: [string, string][] = [
    ['Web Audio', yes(caps.audioContext)],
    ['AudioWorklet (pulse synthesis)', yes(caps.audioWorklet)],
    ['Audio state', snap.audioStatus],
    ['Engine voice', snap.voiceKind === 'none' ? 'Not started' : snap.voiceKind === 'worklet' ? 'Pulse synthesis' : 'Oscillator fallback'],
    ['Sample rate', ctx ? `${ctx.sampleRate} Hz` : '—'],
    ['Output latency', ctx && Number.isFinite(ctx.baseLatency) ? `${Math.round(ctx.baseLatency * 1000)} ms` : '—'],
    ['Recorded engine layer', samples.active ? 'Active' : 'Not installed (procedural only)'],
    ['Geolocation API', yes(caps.geolocation)],
    ['Secure context (HTTPS)', caps.secure ? 'Yes' : 'No — location will be blocked'],
    ['GPS', GPS_STATUS_LABEL[snap.gpsStatus]],
    ['GPS accuracy', snap.gpsAccuracy !== null ? `±${Math.round(snap.gpsAccuracy)} m` : '—'],
    ['GPS fixes received', String(snap.gpsStats.fixes)],
    ['GPS update interval', snap.gpsStats.intervalMs === null ? '—' : `${(snap.gpsStats.intervalMs / 1000).toFixed(1)} s`],
    ['Speed source', snap.gpsStats.speedSource === 'device' ? 'GPS-reported speed' : snap.gpsStats.speedSource === 'position' ? 'Position changes' : '—'],
    ['Motion sensor API', caps.motion ? 'Present (not used for sound)' : 'Not available'],
    ['Touch input', yes(caps.touch)],
    ['Pointer events', yes(caps.pointer)],
    ['Viewport', `${vp.w} × ${vp.h} @${vp.dpr.toFixed(2)}x`],
    ['Simulation mode', snap.sim.mode === 'demo' ? 'Parked demo' : 'Driving'],
    ['Microphone', 'Never used'],
  ];

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="diag-title" onClick={onClose}>
      <div className="sheet__panel" onClick={(e) => e.stopPropagation()}>
        <header className="sheet__head">
          <h2 id="diag-title">Compatibility check</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <dl className="diag">
          {rows.map(([k, v]) => (
            <div key={k} className="diag__row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {snap.audioError && <p className="diag__note">Audio note: {snap.audioError}</p>}
        {samples.failures.length > 0 && <p className="diag__note">Missing recordings: {samples.failures.join(', ')}</p>}
        <p className="diag__note">
          The motion-sensor API is detected but not used: the screen’s orientation relative to the car is unknown, so its
          readings can’t be turned into a reliable acceleration value.
        </p>
      </div>
    </div>
  );
}
