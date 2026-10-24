import { useState, type CSSProperties } from 'react';
import { BRAND } from '../config/brand';
import { useController, useSnapshot } from '../hooks/useController';
import { Tachometer } from '../features/dashboard/Tachometer';
import { VehicleGallery } from '../features/vehicles/VehicleGallery';
import { Diagnostics } from './Diagnostics';
import { Segmented, SoundStatus, VolumeControl } from './Controls';
import type { ShiftControl, SimulationMode } from '../simulation/types';

export function StartScreen() {
  const c = useController();
  const snap = useSnapshot();
  const [diag, setDiag] = useState(false);
  const v = snap.vehicle;

  return (
    <main className="start" style={{ '--accent': v.ui.accent } as CSSProperties}>
      <section className="start__hero">
        <h1 className="wordmark" aria-label={BRAND.name}>
          <span className="wordmark__mark">{BRAND.mark}</span>
          <span className="wordmark__rest">{BRAND.rest}</span>
        </h1>
        <p className="start__tagline">{BRAND.tagline}</p>

        <div className="start__dial">
          <Tachometer profile={v} sweep unitLabel className="dial dial--hero" label="Instrument check" />
          <div className="start__dial-caption">
            <strong>{v.displayName}</strong>
            <span>{v.engineLabel}</span>
          </div>
        </div>

        <button type="button" className="ignition" onClick={() => void c.startEngine()}>
          <span className="ignition__ring" aria-hidden="true" />
          <span className="ignition__text">
            Start
            <br />
            engine
          </span>
        </button>

        <div className="start__audio">
          <SoundStatus status={snap.audioStatus} />
          <VolumeControl value={snap.volume} />
        </div>
      </section>

      <section className="start__setup" aria-label="Setup">
        <div className="field">
          <h2 className="field__title">Mode</h2>
          <Segmented<SimulationMode>
            name="Simulation mode"
            value={snap.sim.mode}
            onChange={(m) => c.setMode(m)}
            options={[
              { value: 'demo', label: 'Parked demo', hint: 'Virtual pedal, works anywhere' },
              { value: 'driving', label: 'Driving', hint: 'Follows your real driving (GPS + phone sensor)' },
            ]}
          />
        </div>

        {snap.sim.mode === 'demo' && (
          <div className="field">
            <h2 className="field__title">Gearbox</h2>
            <Segmented<ShiftControl>
              name="Gear shifting"
              value={snap.sim.shiftControl}
              onChange={(s) => c.setShiftControl(s)}
              options={[
                { value: 'auto', label: 'Automatic' },
                { value: 'manual', label: 'Manual paddles' },
              ]}
            />
          </div>
        )}

        <div className="field field--grow">
          <h2 className="field__title">Sound profile</h2>
          <VehicleGallery selectedId={v.id} onSelect={(id) => c.selectVehicle(id)} />
        </div>

        <footer className="start__foot">
          <p>
            {BRAND.disclaimer} Version {BRAND.version}.
          </p>
          <button type="button" className="linkbtn" onClick={() => setDiag(true)}>
            Compatibility check
          </button>
        </footer>
      </section>

      {diag && <Diagnostics onClose={() => setDiag(false)} />}
    </main>
  );
}
