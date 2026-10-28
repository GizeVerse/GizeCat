// Build-time app identity. The bundle is loaded from out/main/ both in development
// (`electron .` or `electron out/main/index.js`) and inside app.asar, so the app root
// is always two levels up from the main bundle.
import path from 'node:path';

declare const __APP_VERSION__: string | undefined;

/** package.json version inlined by the build; `fallback` when running unbundled. */
export function appVersion(fallback: () => string): string {
  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== '' ? __APP_VERSION__ : fallback();
}

/** Directory containing package.json and assets/, given the main bundle's directory. */
export function appRootFrom(mainDir: string): string {
  return path.resolve(mainDir, '..', '..');
}
