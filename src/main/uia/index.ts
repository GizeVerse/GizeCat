// Browser tab strips through the DesktopCatUia UI Automation helper (ADR 0002 §3).
//   createTabStripService(deps)   -> TabStripService (src/main/contracts.ts)
//   resolveUiaHelperPath(opts)    -> path of DesktopCatUia.exe, or null when it is not installed
import fs from 'node:fs';
import path from 'node:path';

export { createTabStripService, DEFAULT_TAB_STRIP_OPTIONS, TAB_STRIP_BROWSERS, tabStripSurfaceId } from './service';
export type { TabStripDebug, TabStripServiceDeps, TabStripServiceImpl, TabStripServiceOptions } from './service';
export type { ChildProcessLike } from './client';
export { computeTabStripSegment, catExtentPx } from './segment';
export type { StripGeometry, TabStripSegment } from './segment';

/** File name of the helper, both in out/native (dev) and in resources/native (packaged). */
export const UIA_HELPER_EXE = 'DesktopCatUia.exe';

export interface ResolveUiaHelperPathOptions {
  /** app.isPackaged */
  packaged: boolean;
  /** process.resourcesPath (packaged: electron-builder extraResources land in <resources>/native). */
  resourcesPath: string;
  /** app.getAppPath() in development: the repository root, holding out/native after a build. */
  appRoot: string;
}

/**
 * Where the helper lives: `<resources>/native/DesktopCatUia.exe` when packaged,
 * `<appRoot>/out/native/DesktopCatUia.exe` in development (scripts/build-uia-helper.mjs).
 * Null when not on Windows or the file is missing (the build skips it without csc.exe): tab
 * strips then report 'unavailable' and everything else keeps working.
 */
export function resolveUiaHelperPath(opts: ResolveUiaHelperPathOptions): string | null {
  if (process.platform !== 'win32') return null;
  const base = opts.packaged ? opts.resourcesPath : opts.appRoot;
  if (typeof base !== 'string' || base.length === 0) return null;
  const candidate = opts.packaged ? path.join(base, 'native', UIA_HELPER_EXE) : path.join(base, 'out', 'native', UIA_HELPER_EXE);
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}
