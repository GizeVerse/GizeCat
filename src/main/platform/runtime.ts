// Runtime capability detection (ADR 0004 §2.2): starts from the declared table and narrows it
// with what this process observed. Pure, so every platform's mapping is unit-tested here.
import { CAPABILITY_MATRIX, PLATFORM_LABELS, declaredRuntime, type CapabilityId, type PlatformId, type PlatformReport, type RuntimeCapability } from '../../shared/platform';

export interface RuntimeObservations {
  /** Overlays may be created on this platform (overlay profile). */
  overlayAllowed: boolean;
  overlayBlockedReason: string | null;
  /** Displays the cat can use right now. */
  displayCount: number;
  /** A native cursor source answered (win32), or the portable screen fallback is in use. */
  nativeCursor: boolean;
  windowAwareness: 'event-hooks' | 'polling' | 'unavailable';
  taskbarsAvailable: boolean;
  tabStripsAvailable: boolean;
  /** API keys can be stored encrypted (null reason when they can). */
  secretStorageReason: string | null;
  trayCreated: boolean;
  shortcutRegistered: boolean;
  /** The login item can be written by this build (Windows installed builds only). */
  loginItemWritable: boolean;
  loginItemReason: string | null;
  /**
   * The renderer sandbox is in force (no --no-sandbox). Packaged builds refuse to start without it
   * (boot.ts); a development run only warns, so this is informational and narrows nothing (review M3).
   */
  sandboxed: boolean;
}

const OK: RuntimeCapability = Object.freeze({ available: true, reason: null });
const no = (reason: string): RuntimeCapability => ({ available: false, reason });

export const NO_DISPLAY_REASON = 'No display the cat can use was found.';

export function runtimeCapabilities(platform: PlatformId, o: RuntimeObservations): PlatformReport {
  const caps = declaredRuntime(platform);
  const declaredOff = (id: CapabilityId): boolean => !caps[id].available;
  const narrow = (id: CapabilityId, ok: boolean, reason: string): void => {
    if (declaredOff(id)) return;
    caps[id] = ok ? OK : no(reason);
  };

  if (!o.overlayAllowed) {
    const reason = o.overlayBlockedReason ?? CAPABILITY_MATRIX[platform].overlay.note;
    for (const id of ['characterView', 'overlay', 'clickThrough'] as const) caps[id] = no(reason);
  } else if (o.displayCount === 0) {
    for (const id of ['characterView', 'overlay', 'clickThrough'] as const) narrow(id, false, NO_DISPLAY_REASON);
  }
  narrow('windowSurfaces', o.windowAwareness !== 'unavailable', 'Window awareness is unavailable on this system.');
  narrow('taskbarSurfaces', o.taskbarsAvailable, 'The taskbar could not be tracked.');
  narrow('tabStrips', o.tabStripsAvailable, 'The tab-strip helper is unavailable.');
  narrow('globalCursor', o.nativeCursor || platform !== 'win32', 'The cursor position is unavailable.');
  narrow('secretStorage', o.secretStorageReason === null, o.secretStorageReason ?? '');
  narrow('tray', o.trayCreated, 'The tray icon could not be created.');
  narrow('globalShortcut', o.shortcutRegistered, 'The shortcut is in use by another app or not registered.');
  narrow('loginItem', o.loginItemWritable, o.loginItemReason ?? 'This build cannot change startup.');
  return { id: platform, label: PLATFORM_LABELS[platform], capabilities: caps };
}
