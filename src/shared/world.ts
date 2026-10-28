import type { Rect } from './geometry';

/** One monitor, in both Electron DIP and physical pixels. */
export interface DisplayGeometry {
  /** Electron display id, as a string. */
  id: string;
  primary: boolean;
  scaleFactor: number;
  boundsDip: Rect;
  workAreaDip: Rect;
  /** Physical virtual-screen pixels (same space as Win32 GetWindowRect / GetCursorPos). */
  boundsPx: Rect;
  workAreaPx: Rect;
}

/** The set of displays the cat can live on. `version` increments on every topology change. */
export interface WorldGeometry {
  version: number;
  displays: DisplayGeometry[];
}

export const APP_CATEGORIES = [
  'code',
  'terminal',
  'browser',
  'video',
  'game',
  'document',
  'chat',
  'design',
  'media',
  'sensitive',
  'system',
  'other',
  'unknown',
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

/**
 * A top-level application window as seen by the window tracker. Window titles are
 * deliberately absent: they never leave the win32 module (used in-memory for
 * privacy exclusion matching only).
 */
export interface WindowInfo {
  /** Opaque id (HWND as a decimal string). */
  id: string;
  /** Visible frame bounds in physical px (DWMWA_EXTENDED_FRAME_BOUNDS). */
  rect: Rect;
  /** Lower-case executable basename, e.g. "code.exe". Never persisted or logged by default. */
  processName: string;
  category: AppCategory;
  minimized: boolean;
  maximized: boolean;
  /** Covers its whole monitor (borderless/exclusive fullscreen, presentation, video). */
  fullscreen: boolean;
  /** Matches a privacy exclusion (process or title pattern). */
  excluded: boolean;
}

/** A walkable, currently visible top-edge segment of a window, physical px. */
export interface Platform {
  windowId: string;
  y: number;
  x0: number;
  x1: number;
}
