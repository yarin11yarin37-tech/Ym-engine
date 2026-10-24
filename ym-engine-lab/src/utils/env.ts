/** Base URL for public assets (respects Vite's `base`). */
export function baseUrl(): string {
  try {
    const base = import.meta.env?.BASE_URL;
    if (typeof base === 'string' && base.length) return base.endsWith('/') ? base : `${base}/`;
  } catch {
    /* not running under Vite */
  }
  return './';
}
