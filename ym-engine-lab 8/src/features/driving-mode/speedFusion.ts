/**
 * Blends GPS (accurate but ~1 s behind) with the phone's motion sensor
 * (instant but drifts) into one speed/acceleration estimate:
 *  - acceleration comes straight from the motion sensor when it is usable,
 *  - speed integrates that acceleration every frame and is pulled back toward
 *    GPS speed continuously, so drift never builds up.
 * Without a usable motion sensor this simply passes the GPS reading through.
 */
import type { SpeedEstimate } from '../../simulation/EngineSimulator';
import type { SpeedReading } from './speedEstimator';

const GPS_PULL_TC = 0.9;

export class SpeedFusion {
  private speed = 0;
  private hasSpeed = false;

  reset(): void {
    this.speed = 0;
    this.hasSpeed = false;
  }

  update(dt: number, gps: SpeedReading, motionAccel: number | null): SpeedEstimate {
    if (!gps.valid) {
      this.hasSpeed = false;
      return { speed: 0, acceleration: 0, valid: false };
    }
    if (motionAccel === null || !Number.isFinite(motionAccel)) {
      this.speed = gps.speed;
      this.hasSpeed = true;
      return { speed: gps.speed, acceleration: gps.acceleration, valid: true };
    }
    if (!this.hasSpeed) {
      this.speed = gps.speed;
      this.hasSpeed = true;
    }
    const step = Math.min(0.05, Math.max(0, dt));
    this.speed += motionAccel * step;
    this.speed += (gps.speed - this.speed) * (1 - Math.exp(-step / GPS_PULL_TC));
    // Standing still: ignore sensor noise.
    if (gps.speed < 0.5 && Math.abs(motionAccel) < 0.6) this.speed += (gps.speed - this.speed) * 0.2;
    this.speed = Math.max(0, this.speed);
    return { speed: this.speed, acceleration: motionAccel, valid: true };
  }
}
