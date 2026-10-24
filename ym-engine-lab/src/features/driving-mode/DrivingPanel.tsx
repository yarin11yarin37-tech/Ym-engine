import { useController, useSnapshot } from '../../hooks/useController';
import { GPS_STATUS_LABEL, type GpsStatus } from './gpsTracker';
import { MOTION_STATUS_LABEL, type MotionStatus } from './motionSensor';

const TONE: Record<GpsStatus, 'ok' | 'wait' | 'bad'> = {
  inactive: 'wait',
  unsupported: 'bad',
  'insecure-context': 'bad',
  'awaiting-permission': 'wait',
  denied: 'bad',
  acquiring: 'wait',
  connected: 'ok',
  'poor-accuracy': 'wait',
  lost: 'bad',
};

const HELP: Partial<Record<GpsStatus, string>> = {
  unsupported: 'This browser does not provide location. Parked demo works without it.',
  'insecure-context': 'Browsers only share location with sites served over HTTPS. Open the HTTPS address of this app.',
  denied: 'Location was blocked. Allow it in the browser’s site settings, or use the parked demo.',
  acquiring: 'Waiting for the first position fix. This can take a little while after a cold start.',
  'awaiting-permission': 'If the browser asks, allow location. Then it waits for the first GPS fix.',
  'poor-accuracy': 'The position is too imprecise to estimate speed. Sound holds at idle until it improves.',
  lost: 'The browser allowed location but isn’t sending positions. Sound holds at idle. Try reloading the page; the details below tell us why.',
};

const MOTION_TONE: Record<MotionStatus, 'ok' | 'wait' | 'bad'> = {
  off: 'wait',
  unsupported: 'wait',
  denied: 'bad',
  waiting: 'wait',
  learning: 'wait',
  active: 'ok',
};

const MOTION_HELP: Partial<Record<MotionStatus, string>> = {
  unsupported: 'This browser has no motion sensor, so the sound follows GPS only (about a second behind).',
  denied:
    'Motion access was blocked. On iPhone: Settings → Apps → Safari → Motion & Orientation Access, then reload and tap Start engine.',
  waiting: 'Starting the motion sensor.',
  learning:
    'Keep the phone fixed in its mount and drive normally. After a few clear accelerations or brakings it learns how the phone faces, then reacts instantly.',
};

export function DrivingPanel() {
  const c = useController();
  const snap = useSnapshot();
  const st = snap.gpsStatus;
  const failed = st === 'unsupported' || st === 'insecure-context' || st === 'denied';

  return (
    <div className="drive">
      <p className={`gps gps--${TONE[st]}`} role="status">
        <i aria-hidden="true" />
        {GPS_STATUS_LABEL[st]}
        {snap.gpsAccuracy !== null && st !== 'denied' && <span className="gps__acc">±{Math.round(snap.gpsAccuracy)} m</span>}
      </p>
      {HELP[st] && <p className="drive__help">{HELP[st]}</p>}
      {snap.sim.status === 'off' && (
        <p className="drive__help">The engine is off. Press Start engine (before you drive) to hear it.</p>
      )}
      <p className="drive__stats" aria-label="GPS details">
        <span>Fixes {snap.gpsStats.fixes}</span>
        <span>Update every {snap.gpsStats.intervalMs === null ? '—' : `${(snap.gpsStats.intervalMs / 1000).toFixed(1)} s`}</span>
        {snap.gpsLowAccuracy && <span>Low-accuracy mode</span>}
        {snap.gpsError && <span>Last error: {snap.gpsError}</span>}
        <span>
          Speed from{' '}
          {snap.gpsStats.speedSource === 'device' ? 'GPS speed' : snap.gpsStats.speedSource === 'position' ? 'position changes' : '—'}
        </span>
      </p>
      <p className={`gps gps--small gps--${MOTION_TONE[snap.motionStatus]}`} role="status">
        <i aria-hidden="true" />
        {MOTION_STATUS_LABEL[snap.motionStatus]}
        {snap.motionStatus === 'learning' && <span className="gps__acc">{Math.round(snap.motionConfidence * 100)}%</span>}
      </p>
      {MOTION_HELP[snap.motionStatus] && <p className="drive__help">{MOTION_HELP[snap.motionStatus]}</p>}
      {snap.motionStatus === 'active' && (
        <button type="button" className="linkbtn" onClick={() => c.recalibrateMotion()}>
          Phone moved in the mount? Learn its direction again
        </button>
      )}
      <p className="drive__note">
        With the motion sensor active, braking and acceleration are heard almost instantly; GPS keeps the speed accurate. The app can’t read your real pedal or motor. Location stays
        on this device and stops when you switch to Parked demo.
      </p>
      <div className="drive__actions">
        {failed ? (
          <button type="button" className="btn btn--primary" onClick={() => c.setMode('demo')}>
            Switch to parked demo
          </button>
        ) : null}
      </div>
      <p className="drive__safety">Eyes on the road. No controls here need touching while driving.</p>
    </div>
  );
}
