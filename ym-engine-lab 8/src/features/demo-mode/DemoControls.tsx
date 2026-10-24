import { useController, useSnapshot } from '../../hooks/useController';
import { Segmented } from '../../components/Controls';
import { AcceleratorPedal } from './AcceleratorPedal';
import type { DemoDrive, ShiftControl } from '../../simulation/types';

const PRESETS = [0.25, 0.5, 0.75, 1];

export function DemoControls() {
  const c = useController();
  const { sim, pedalLevel } = useSnapshot();
  const running = sim.status === 'running';
  const inDrive = sim.demoDrive === 'drive';
  const manual = sim.shiftControl === 'manual';

  return (
    <div className="demo">
      <div className="demo__toggles">
        <Segmented<DemoDrive>
          name="Drivetrain"
          value={sim.demoDrive}
          onChange={(d) => c.setDemoDrive(d)}
          options={[
            { value: 'neutral', label: 'Free rev', hint: 'Engine only' },
            { value: 'drive', label: 'Virtual car', hint: 'With gears and speed' },
          ]}
        />
        <Segmented<ShiftControl>
          name="Gear shifting"
          value={sim.shiftControl}
          onChange={(s) => c.setShiftControl(s)}
          disabled={!inDrive}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'manual', label: 'Manual' },
          ]}
        />
      </div>

      <div className="gas" role="group" aria-label="Gas amount">
        <div className="gas__head">
          <span>Gas amount</span>
          <b>{Math.round(pedalLevel * 100)}%</b>
        </div>
        <input
          id="gas-amount"
          type="range"
          min={10}
          max={100}
          step={5}
          value={Math.round(pedalLevel * 100)}
          onChange={(e) => c.setPedalLevel(Number(e.currentTarget.value) / 100)}
          aria-label="Gas amount for each pedal press"
        />
        <div className="gas__presets">
          {PRESETS.map((v) => (
            <button
              key={v}
              type="button"
              className={`chip${Math.abs(pedalLevel - v) < 0.01 ? ' is-on' : ''}`}
              onClick={() => c.setPedalLevel(v)}
            >
              {Math.round(v * 100)}%
            </button>
          ))}
        </div>
      </div>

      <div className="demo__drive">
        <div className="paddles" aria-label="Gear paddles">
          <button
            type="button"
            className="paddle"
            onClick={() => c.gearDown()}
            disabled={!running || !inDrive || !manual || sim.gear <= 1}
            aria-label="Gear down"
          >
            <span aria-hidden="true">−</span>
            <small>Down</small>
          </button>
          <button
            type="button"
            className="paddle"
            onClick={() => c.gearUp()}
            disabled={!running || !inDrive || !manual || sim.gear >= sim.gearCount}
            aria-label="Gear up"
          >
            <span aria-hidden="true">+</span>
            <small>Up</small>
          </button>
        </div>
        <AcceleratorPedal disabled={!running} />
      </div>

      <div className="demo__actions">
        <button type="button" className="chip" onClick={() => c.blip()} disabled={!running}>
          Blip
        </button>
        <button type="button" className={`chip${sim.launchActive ? ' is-on' : ''}`} onClick={() => c.launch()} disabled={!running}>
          Launch demo
        </button>
        <button type="button" className="chip" onClick={() => c.returnToIdle()} disabled={!running}>
          Back to idle
        </button>
      </div>
      <p className="demo__hint">Keyboard: hold Space for gas · Q / E shift · B blip · I idle</p>
    </div>
  );
}
