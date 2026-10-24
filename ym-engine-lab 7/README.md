# YM ENGINE LAB

Real-time virtual engine sound for electric cars, built for the Tesla in-car browser and working on desktop and mobile. Pick a sound profile, then either rev a virtual engine while parked (Parked demo) or let GPS speed drive the sound while you drive (Driving).

Everything runs in the browser. No account, backend, Tesla API, vehicle connection or microphone.

> Simulated sound only. Not affiliated with Tesla or any vehicle manufacturer. Profile names describe what inspired each sound; the audio is generated, not recorded from those vehicles.

## Run locally

Requires Node 18.18+.

```bash
npm install
npm run dev        # http://localhost:5173 (also on your LAN)
```

Other commands:

```bash
npm test           # unit tests (Vitest)
npm run typecheck  # TypeScript
npm run lint       # ESLint
npm run build      # production build → dist/
npm run preview    # serve dist/ locally
npm run check      # all of the above
```

Location only works on `https://` or `localhost`. To test Driving mode on a phone, deploy (below) or use an HTTPS tunnel.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. On vercel.com: **Add New → Project**, import the repo. Vercel detects Vite; `vercel.json` already sets the build command (`npm run build`) and output (`dist`).
3. Deploy. You get an HTTPS URL like `ym-engine-lab.vercel.app`. Open it in the car's browser.

Or from the terminal: `npm i -g vercel && vercel --prod`.

Any static HTTPS host works (Netlify, Cloudflare Pages, GitHub Pages): build with `npm run build` and upload `dist/`. Asset paths are relative, so sub-paths work too.

### Custom domain

1. In the Vercel project: **Settings → Domains → Add**, enter e.g. `enginelab.example.com`.
2. At your DNS provider, add the record Vercel shows — usually `CNAME enginelab → cname.vercel-dns.com` for a subdomain, or an `A` record to `76.76.21.21` for the bare domain.
3. Vercel issues the HTTPS certificate automatically once DNS resolves (minutes to a few hours).

HTTPS is required: browsers block geolocation on plain `http://` pages, so Driving mode would show "Location needs HTTPS".

## How it works

| Area | Where |
|---|---|
| Simulation (framework-independent) | `src/simulation/` — `EngineSimulator`, drivetrain, gearbox, throttle input, profile validator |
| Audio engine | `src/features/audio/` — `AudioEngine` (layered Web Audio graph), `engineVoiceWorklet` (pulse synthesiser), `SampleBank` + `assetManifest` (optional recordings) |
| GPS | `src/features/driving-mode/` — `SpeedEstimator` (filtering, stale/invalid handling), `GpsTracker` (permission + watcher) |
| Orchestration | `src/services/EngineController.ts` — frame loop, lifecycle guards, throttled UI snapshot |
| Vehicle data | `src/data/vehicles.ts` — all eight profiles, every value editable |
| UI | `src/components/`, `src/features/dashboard/`, `src/features/demo-mode/` |
| Brand name | `src/config/brand.ts` |

**Sound.** The main voice is an AudioWorklet that synthesises exhaust pulses at each engine layout's real firing angles (cross-plane V8 per-bank unevenness, even-fire V10/V12, flat-six, inline-six) and rings them through per-bank exhaust resonators, with cylinder variance, idle timing jitter and overrun pops. Around it: engine-order harmonics, intake noise, exhaust saturation with dynamic EQ and low-pass, turbo whine/hiss/blow-off (or flutter), supercharger whine, shift torque-cut and ignition-cut cracks, a starter on ignition, a limiter and master volume. The graph is built once; per frame only AudioParams move. If AudioWorklet is missing, an oscillator voice takes over. Procedural synthesis is recognisably engine-like and distinct per profile, but it is not studio-recording realism — that's what the recorded layer is for.

**Driving mode.** GPS speed is filtered (accuracy threshold 35 m, plausibility and acceleration limits, smoothing, short dead-reckoning between 1 Hz fixes). RPM comes from speed × virtual gear ratio × final drive ÷ tyre circumference; load is estimated from acceleration. Shifting uses throttle-dependent up/down lines with hysteresis, minimum dwell and kickdown. After 4.5 s without a valid fix the sound fades to idle and speed shows "—". Location stays in memory on the device and the watcher stops when you leave Driving mode or hide the tab. The virtual gearbox is forced to automatic while driving, and nothing on that screen needs touching on the move.

**Stuck-pedal protection.** The pedal releases on pointer up/cancel/lost-capture, long-press menu, window blur, tab hide, page hide and unmount; keyboard keys release on keyup and blur.

## iPhone with the motion sensor (fastest response)

Open the site in Safari on an iPhone mounted in the car and connected to the car's Bluetooth audio. Choose **Driving** and tap **Start engine**; allow Location and Motion & Orientation when asked. Drive normally: after a few clear accelerations or brakings the app learns which way the phone faces and from then on reacts to braking and acceleration within a few tenths of a second, while GPS keeps the speed accurate. Keep the phone fixed in its mount; if it moves, tap "Learn its direction again". Hold the phone sideways for the Tesla-style one-screen layout. The Tesla browser has no motion sensor, so there the sound follows GPS only.

If motion access was refused: Settings → Apps → Safari → Motion & Orientation Access.

## Adding licensed engine recordings

See the comments in `src/features/audio/assetManifest.ts`. In short: put steady-RPM loops (on-load and off-load, 4–8 RPM points, seamless, 48 kHz mono `.ogg`/`.m4a`) in `public/audio/<vehicle-id>/`, add an entry to `SAMPLE_MANIFEST`, reload. The layer equal-power-crossfades between neighbouring RPM points and keeps the procedural engine underneath. Missing files are skipped and listed in **Check** (diagnostics); the app never depends on them.

**Still needed for recorded realism:** licensed loops for each of the eight profiles. None are included.

## Vehicle photos

Each profile has a `ui.image` slot. Put a licensed photograph in `public/vehicles/` and set e.g. `image: 'vehicles/m5.jpg'`. Without one, the card shows a neutral "Photo slot" placeholder. Don't use manufacturer logos.

## Known limits

- The Tesla browser's exact geolocation update rate, accuracy and background behaviour vary by software version; the app feature-detects and shows the state in **Check**, but this build has not been tested inside a car.
- The motion-sensor API is detected but not used: the screen's orientation relative to the car is unknown, so it can't give a reliable acceleration value.
- Some browsers suspend audio when the tab is hidden; a "Resume sound" button appears when that happens.
