declare const __BUILD_TIME__: string | undefined;

/** Brand configuration — change the product name here only. */
export const BRAND = {
  name: 'YM ENGINE LAB',
  /** Split for the wordmark treatment. */
  mark: 'YM',
  rest: 'ENGINE LAB',
  tagline: 'Virtual engine sound for electric cars',
  /** Shown on screen so you can confirm which build the car is running. */
  version: '1.8',
  /** Filled in by the build (date/time the file was produced). */
  build: (typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '') as string,
  disclaimer:
    'Simulated sound only. Not affiliated with Tesla or any vehicle manufacturer. Vehicle names describe the sound profile’s inspiration; audio is generated, not recorded from those vehicles.',
} as const;
