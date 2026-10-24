/**
 * Firing-angle helpers (4-stroke: one firing per cylinder per 720° of crank).
 * Angles are grouped by exhaust bank so the audio engine can give each bank its
 * own pipe character — bank imbalance is what produces a cross-plane V8 "lope".
 */

/** Evenly spaced firing on one or two alternating banks. */
export function evenFiring(cylinders: number, banks: 1 | 2): number[][] {
  const interval = 720 / cylinders;
  const angles = Array.from({ length: cylinders }, (_, i) => i * interval);
  if (banks === 1) return [angles];
  return [angles.filter((_, i) => i % 2 === 0), angles.filter((_, i) => i % 2 === 1)];
}

/**
 * Cross-plane V8, firing order 1-8-4-3-6-5-7-2 with cylinders 1-4 on the left
 * bank. Each bank fires unevenly (180/90/360/90 and 270/90/90/270), which is
 * where the classic burble comes from when the banks are not perfectly merged.
 */
export function crossPlaneV8(): number[][] {
  return [
    [0, 180, 270, 630],
    [90, 360, 450, 540],
  ];
}

/** Flattened list of all firing events sorted by angle, tagged with bank index. */
export function flattenFiring(banks: number[][]): { angle: number; bank: number }[] {
  const events: { angle: number; bank: number }[] = [];
  banks.forEach((angles, bank) => angles.forEach((angle) => events.push({ angle, bank })));
  return events.sort((a, b) => a.angle - b.angle);
}

/** Firing frequency in Hz for a 4-stroke engine. */
export function firingFrequency(rpm: number, cylinders: number): number {
  return (rpm / 60) * (cylinders / 2);
}
