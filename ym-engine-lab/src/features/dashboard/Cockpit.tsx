import { useState, type CSSProperties } from 'react';
import { BRAND } from '../../config/brand';
import { useController, useSnapshot } from '../../hooks/useController';
import { Segmented, SimTag, SoundStatus, VolumeControl } from '../../components/Controls';
import { Diagnostics } from '../../components/Diagnostics';
import { DemoControls } from '../demo-mode/DemoControls';
import { useKeyboardControls } from '../demo-mode/useKeyboardControls';
import { DrivingPanel } from '../driving-mode/DrivingPanel';
import { Tachometer } from './Tachometer';
import { msToKmh } from '../../utils/math';
import type { SimulationMode } from '../../simulation/types';

const STATUS_LABEL = { off: 'Engine off', cranking: 'Starting', running: 'Running', stopping: 'Shutting down' } as const;

function Bar({ value, label, detail, tag }: { value: number; label: string; detail: string; tag?: string }) {
  return (
    <div className="readout readout--bar">
      <div className="readout__head">
        <span className="readout__label">{label}</span>
        {tag && <SimTag>{tag}</SimTag>}
      </div>
      <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}>
        <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, value))})` }} />
      </div>
      <span className="readout__detail">{detail}</span>
    </div>
  );
}

export function Cockpit() {
  const c = useController();
  const snap = useSnapshot();
  const [diag, setDiag] = useState(false);
  const { sim, vehicle: v } = snap;
  const demo = sim.mode === 'demo';
  useKeyboardControls(c, demo && sim.status === 'running');

  const running = sim.status === 'running' || sim.status === 'cranking';
  const speedKnown = sim.speedSource !== 'none';
  const gearLabel = sim.gear === 0 ? 'N' : String(sim.gear);
  const forced = v.induction !== 'none';
  const needsResume = snap.audioStatus === 'suspended' || snap.audioStatus === 'error';

  return (
    <main className="cockpit" style={{ '--accent': v.ui.accent, '--accent-soft': v.ui.accentSoft } as CSSProperties}>
      <header className="topbar">
        <span className="topbar__brand" aria-label={BRAND.name}>
          <b>{BRAND.mark}</b> {BRAND.rest}
        </span>
        <span className="topbar__vehicle">
          <strong>{v.displayName}</strong>
          <span>{v.engineLabel}</span>
        </span>
        <div className="topbar__mode">
          <Segmented<SimulationMode>
            name="Mode"
            value={sim.mode}
            onChange={(m) => c.setMode(m)}
            options={[
              { value: 'demo', label: 'Parked demo' },
              { value: 'driving', label: 'Driving' },
            ]}
          />
        </div>
        <SoundStatus status={snap.audioStatus} />
        <VolumeControl value={snap.volume} compact />
        <button type="button" className="btn btn--ghost" onClick={() => setDiag(true)}>
          Check
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => void c.exit()}>
          Exit
        </button>
      </header>

      {needsResume && (
        <div className="banner" role="alert">
          <span>{snap.audioStatus === 'error' ? `Sound couldn’t start${snap.audioError ? `: ${snap.audioError}` : '.'}` : 'Sound is paused by the browser.'}</span>
          <button type="button" className="btn btn--primary" onClick={() => void c.resumeAudio()}>
            {snap.audioStatus === 'error' ? 'Retry sound' : 'Resume sound'}
          </button>
        </div>
      )}

      <section className="cluster">
        <aside className="readouts" aria-label="Readouts">
          <div className="readout readout--speed">
            <div className="readout__head">
              <span className="readout__label">Speed</span>
              <SimTag>{sim.speedSource === 'gps' ? 'GPS estimate' : sim.speedSource === 'virtual' ? 'Virtual car' : 'No signal'}</SimTag>
            </div>
            <span className="speed">
              <b>{speedKnown ? Math.round(msToKmh(sim.speed)) : '—'}</b>
              <small>km/h</small>
            </span>
          </div>
          <Bar
            label={demo ? 'Throttle' : 'Estimated load'}
            tag={demo ? undefined : 'Simulated'}
            value={sim.throttle}
            detail={`${Math.round(sim.throttle * 100)} %`}
          />
          {forced && (
            <Bar
              label={v.induction === 'supercharger' ? 'Supercharger boost' : 'Turbo boost'}
              tag="Simulated"
              value={sim.boost}
              detail={`${(sim.boost * v.boost.maxBar).toFixed(2)} bar`}
            />
          )}
          <Bar label="Coolant" tag="Simulated" value={(sim.temperature - 40) / 70} detail={`${Math.round(sim.temperature)} °C`} />
        </aside>

        <div className="gauge">
          <Tachometer
            profile={v}
            readRpm={() => c.live.rpm}
            readLimiter={() => c.live.limiterActive}
            className="dial dial--live"
          />
          <div className="gauge__center">
            <span className={`gear${sim.shifting ? ' is-shifting' : ''}`} aria-live="polite" aria-label={`Gear ${gearLabel}`}>
              {gearLabel}
            </span>
            <span className="gauge__rpm">{Math.round(sim.rpm / 10) * 10} rpm</span>
            <span className="gauge__state">
              {STATUS_LABEL[sim.status]}
              {sim.launchActive ? ', launch demo' : ''}
              {demo ? '' : ', virtual gear'}
            </span>
          </div>
          <button
            type="button"
            className={`power${running ? ' is-on' : ''}`}
            onClick={() => c.toggleEngine()}
            aria-label={running ? 'Stop engine' : 'Start engine'}
          >
            {running ? 'Stop engine' : 'Start engine'}
          </button>
        </div>

        <aside className="controls" aria-label={demo ? 'Demo controls' : 'Driving mode'}>
          {demo ? <DemoControls /> : <DrivingPanel />}
        </aside>
      </section>

      {diag && <Diagnostics onClose={() => setDiag(false)} />}
    </main>
  );
}
