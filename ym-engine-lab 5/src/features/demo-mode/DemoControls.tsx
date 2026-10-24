import { useController, useSnapshot } from '../../hooks/useController';
import { Segmented } from '../../components/Controls';
import { AcceleratorPedal } from './AcceleratorPedal';
import type { DemoDrive, ShiftControl } from '../../simulation/types';

export function DemoControls() {
  const c = useController();
  const { sim } = useSnapshot();
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
      <p className="demo__hint">Keyboard: hold Space to rev · Q / E shift · B blip · I idle</p>
    </div>
  );
}
