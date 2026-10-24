/**
 * Licensed engine recordings (optional).
 *
 * The app ships with procedural synthesis only. To upgrade a profile with real
 * recordings you have the rights to use:
 *
 *  1. Record or license steady-state loops at fixed RPM points, ideally both
 *     on-load (throttle open, under load) and off-load (throttle closed / overrun).
 *     4–8 points across the rev range, 1–3 s each, seamless loops, 48 kHz mono.
 *  2. Put the files in /public/audio/<vehicle-id>/ (e.g. on_3000.ogg, off_3000.ogg).
 *     Provide .ogg or .m4a; .wav works too but is large.
 *  3. Add an entry below. `rpm` must be the exact steady RPM of the loop.
 *  4. Reload: the sample layer crossfades between neighbouring RPM points with an
 *     equal-power curve and pitch-shifts within ±12 % of each recording. The
 *     procedural engine stays underneath at `proceduralBlend` to cover gaps.
 *
 * Missing or undecodable files are skipped with a diagnostic; the procedural
 * engine always keeps running, so the app never depends on these files.
 * Do not point these URLs at third-party hosts.
 */
export interface SampleLayerSpec {
  rpm: number;
  /** Path relative to the site root, e.g. "audio/bmw-m5-competition/on_3000.ogg". */
  onLoad?: string;
  offLoad?: string;
}

export interface VehicleSampleSet {
  vehicleId: string;
  layers: SampleLayerSpec[];
  /** Overall level of the recorded layer. */
  gain: number;
  /** Level of the procedural engine kept under the recordings (0..1). */
  proceduralBlend: number;
  /** Credit / licence note shown in diagnostics. */
  license: string;
}

export const SAMPLE_MANIFEST: VehicleSampleSet[] = [
  // Example — uncomment after adding licensed files:
  // {
  //   vehicleId: 'bmw-m5-competition',
  //   gain: 0.9,
  //   proceduralBlend: 0.25,
  //   license: 'Recorded by …, licensed under …',
  //   layers: [
  //     { rpm: 1000, onLoad: 'audio/bmw-m5-competition/on_1000.ogg', offLoad: 'audio/bmw-m5-competition/off_1000.ogg' },
  //     { rpm: 2500, onLoad: 'audio/bmw-m5-competition/on_2500.ogg', offLoad: 'audio/bmw-m5-competition/off_2500.ogg' },
  //     { rpm: 4000, onLoad: 'audio/bmw-m5-competition/on_4000.ogg', offLoad: 'audio/bmw-m5-competition/off_4000.ogg' },
  //     { rpm: 5500, onLoad: 'audio/bmw-m5-competition/on_5500.ogg', offLoad: 'audio/bmw-m5-competition/off_5500.ogg' },
  //     { rpm: 7000, onLoad: 'audio/bmw-m5-competition/on_7000.ogg', offLoad: 'audio/bmw-m5-competition/off_7000.ogg' },
  //   ],
  // },
];

export function getSampleSet(vehicleId: string): VehicleSampleSet | undefined {
  return SAMPLE_MANIFEST.find((s) => s.vehicleId === vehicleId && s.layers.length > 0);
}

/**
 * Equal-power crossfade weights for a set of RPM points. Returns one weight per
 * point; at most two are non-zero. Pure so it can be unit-tested.
 */
export function rpmCrossfadeWeights(points: number[], rpm: number): number[] {
  const w = points.map(() => 0);
  if (points.length === 0) return w;
  if (rpm <= points[0]) {
    w[0] = 1;
    return w;
  }
  const last = points.length - 1;
  if (rpm >= points[last]) {
    w[last] = 1;
    return w;
  }
  for (let i = 0; i < last; i++) {
    if (rpm >= points[i] && rpm < points[i + 1]) {
      const t = (rpm - points[i]) / (points[i + 1] - points[i]);
      w[i] = Math.cos((t * Math.PI) / 2);
      w[i + 1] = Math.sin((t * Math.PI) / 2);
      break;
    }
  }
  return w;
}
