// Public entry of the Win32 integration (main process only).
import type { Logger } from '../contracts';
import { loadWin32Native } from './native';
import { createKoffiWin32Api, createUnavailableWin32Api } from './win32Api';
import type { ExtendedWin32Api, Win32ApiOptions } from './win32Api';

export { categorizeProcess, exeBasename, ExclusionRules } from './processNames';
export { createWindowTracker } from './windowTracker';
export type { WindowTrackerDebug, WindowTrackerExtras, WindowTrackerOptions } from './windowTracker';
export { createActivityMonitor } from './activityMonitor';
export { createTaskbarTracker, createUnavailableTaskbarTracker, taskbarSurfaceId } from './taskbar';
export type { TaskbarNative, TaskbarRediscoverReason, TaskbarTrackerHandle, TaskbarTrackerOptions } from './taskbar';
export type { ActivityMonitorExtras, ActivityMonitorOptions } from './activityMonitor';
export { computePlatforms, computeFullscreenDisplayIds, MIN_PLATFORM_WIDTH } from './platforms';
export { createUnavailableWin32Api, hasWin32Extensions } from './win32Api';
export { sameWindowExclusions, titleChecksActive, windowExclusionsFor } from './exclusionPolicy';
export type { WindowExclusions } from './exclusionPolicy';
export type { ExtendedWin32Api, Win32ApiExtensions, Win32ApiOptions } from './win32Api';

/**
 * Creates the koffi-backed Win32 facade. If koffi, its native binary or a system DLL
 * cannot be loaded (or the platform is not Windows) a safe fallback with
 * `available === false` is returned; it never throws.
 */
export function createWin32Api(logger: Logger, opts: Win32ApiOptions = {}): ExtendedWin32Api {
  try {
    return createKoffiWin32Api(loadWin32Native(), logger, opts);
  } catch (e) {
    logger.child('win32').warn('Win32 integration unavailable; window awareness disabled', { error: e instanceof Error ? e.message : String(e) });
    return createUnavailableWin32Api();
  }
}
