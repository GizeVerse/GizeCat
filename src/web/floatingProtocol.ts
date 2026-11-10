// The messages between the Android app's native code and the web bundle for the floating cat
// (1.4.1). Two bridges, both JSON strings over androidx.webkit's addWebMessageListener, so
// they exist only in frames of the app's own origin:
//
// - the OVERLAY bridge (`window.gizecatOverlay`): inside the transparent window the foreground
//   service floats over other apps. Native -> page: screen metrics, raw touches, commands. Page ->
//   native: where the window must be, hello, saved.
// - the CONTROL bridge (`window.gizecatFloating`): inside the app's own screen (the settings sheet).
//   Page -> native: start, stop, pause, hide, permission and notification steps. Native -> page: the
//   floating cat's state.
//
// Everything is parsed defensively on both sides: unknown types, extra shapes, non-finite or absurd
// numbers and oversized strings are refused and never throw. No message carries a cat, a setting, a
// file or any user data: the cat and the settings stay in the page's localStorage, native only
// forwards signals ("settings changed", "save now").
//
// Pure: no DOM types, no globals (the page-side adapters are in floatingBridges.ts).

export const FLOATING_PROTOCOL_VERSION = 1;
/** The page-side globals added by addWebMessageListener (android/.../OverlayWindow.kt, FloatingBridge.kt). */
export const OVERLAY_BRIDGE_NAME = 'gizecatOverlay';
export const CONTROL_BRIDGE_NAME = 'gizecatFloating';
/** The page the overlay window loads: `index.html?surface=overlay`. Read by main.ts. */
export const OVERLAY_SURFACE_QUERY = 'surface';
export const OVERLAY_SURFACE_VALUE = 'overlay';

/** Longest message accepted, in UTF-16 units (they are tiny; this only bounds garbage). */
export const MAX_MESSAGE_CHARS = 2048;
/** Largest coordinate or size accepted (dp): far beyond any display, finite and safe to compute with. */
const LIMIT_DP = 100_000;

/** Insets of the display's system bars and cutout, dp. */
export interface InsetsDp {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The physical screen as native sees it, in dp (CSS px). */
export interface ScreenMetrics {
  width: number;
  height: number;
  /** Physical pixels per dp. */
  density: number;
  insets: InsetsDp;
}

export const OVERLAY_COMMANDS = ['pause', 'resume', 'hide', 'show', 'suspend', 'wake', 'save', 'reloadSettings'] as const;
export type OverlayCommand = (typeof OVERLAY_COMMANDS)[number];

/**
 * down, move, up, cancel: a finger (or a pressed mouse button) on the cat's touch window.
 * hover, leave: a mouse or trackpad pointer moving over it with no button pressed (Android delivers
 * hover only to the window under the pointer, so this is the only pointer movement the cat can see).
 */
export const POINTER_KINDS = ['down', 'move', 'up', 'cancel', 'hover', 'leave'] as const;
export type PointerKind = (typeof POINTER_KINDS)[number];

/**
 * Native -> overlay page. Pointer positions are raw screen coordinates in dp: the world's own. `ms`
 * is the event's own time on native's uptime clock (MotionEvent.getEventTime), so a flick's speed is
 * the finger's, not the message queue's. `hint` is a touch inside GizeCat's OWN app window (the only
 * touches an app is allowed to see besides the cat's), offered to the cat as something to look at.
 */
export type OverlayInbound =
  | { t: 'metrics'; metrics: ScreenMetrics }
  | { t: 'ptr'; k: PointerKind; id: number; x: number; y: number; ms: number }
  | { t: 'hint'; x: number; y: number }
  | { t: 'cmd'; c: OverlayCommand };

/** A rectangle in screen dp (whole device pixels). */
export interface RectDp {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Overlay page -> native. The rectangle `x y w h` is the VISUAL window: the cat and the room it draws
 * into. It never takes touches (native makes it not touchable), so everything outside the cat's touch
 * window reaches the app underneath. `tx ty tw th` is the TOUCH window: only the cat's own footprint
 * and a small pad, a separate, invisible window that takes the cat's touches. `touch` is false while
 * the cat takes none (paused, interactions off): native then removes the touch window altogether.
 */
export type OverlayOutbound =
  | { t: 'hello'; v: number }
  | { t: 'win'; x: number; y: number; w: number; h: number; vis: boolean; touch: boolean; tx: number; ty: number; tw: number; th: number }
  | { t: 'saved'; ok: boolean };

export const CONTROL_OPS = [
  'query',
  'start',
  'stop',
  'pause',
  'resume',
  'hide',
  'show',
  'openOverlaySettings',
  'settingsChanged',
] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

/** Why the floating cat is not running, when it stopped by itself or could not start. */
export const STOP_REASONS = ['none', 'user', 'permission-missing', 'permission-revoked', 'renderer-failed', 'system'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** Native -> app page: everything the sheet needs to show the floating cat's controls. */
export interface FloatingState {
  running: boolean;
  paused: boolean;
  hidden: boolean;
  /** SYSTEM_ALERT_WINDOW ("Display over other apps") is granted: Settings.canDrawOverlays(). */
  overlayPermission: boolean;
  /** Notifications can be shown (Android 13+ permission, or older); false: the controls live in the app only. */
  notifications: boolean;
  /** The notification permission can still be asked for (never declined, Android 13+). */
  canAskNotifications: boolean;
  /** Why the cat is not running; 'none' while it runs or before it was ever started. */
  lastStop: StopReason;
}

export const NO_FLOATING: FloatingState = Object.freeze({
  running: false,
  paused: false,
  hidden: false,
  overlayPermission: false,
  notifications: false,
  canAskNotifications: false,
  lastStop: 'none',
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const num = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_MESSAGE_CHARS) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function hasOnly(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

function parseInsets(v: unknown): InsetsDp | null {
  if (!isRecord(v) || !hasOnly(v, ['top', 'right', 'bottom', 'left'])) return null;
  const top = num(v.top, 0, LIMIT_DP);
  const right = num(v.right, 0, LIMIT_DP);
  const bottom = num(v.bottom, 0, LIMIT_DP);
  const left = num(v.left, 0, LIMIT_DP);
  return top === null || right === null || bottom === null || left === null ? null : { top, right, bottom, left };
}

export function parseScreenMetrics(v: unknown): ScreenMetrics | null {
  if (!isRecord(v) || !hasOnly(v, ['width', 'height', 'density', 'insets'])) return null;
  const width = num(v.width, 1, LIMIT_DP);
  const height = num(v.height, 1, LIMIT_DP);
  const density = num(v.density, 0.5, 16);
  const insets = parseInsets(v.insets);
  if (width === null || height === null || density === null || insets === null) return null;
  // Bars can never cover the whole screen: the work area keeps at least one dp each way.
  if (insets.left + insets.right >= width || insets.top + insets.bottom >= height) return null;
  return { width, height, density, insets };
}

/**
 * The metrics native puts in the overlay page's URL (`?surface=overlay&w=1280&h=800&d=2&it=24&ir=0&ib=0&il=0`),
 * so the page has the screen before its first frame; the bridge only works once the page has posted
 * its first message. null when anything is missing or out of range (the page then does not start as an overlay).
 */
export function parseMetricsQuery(search: string): ScreenMetrics | null {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    return null;
  }
  const read = (key: string, decimals = 3): number | null => {
    const raw = q.get(key);
    if (raw === null || raw.length === 0 || raw.length > 16 || !new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(raw)) return null;
    return Number(raw);
  };
  const width = read('w');
  const height = read('h');
  // Native positions windows with the exact float density: six decimals, so both sides agree to the pixel.
  const density = read('d', 6);
  const top = read('it');
  const right = read('ir');
  const bottom = read('ib');
  const left = read('il');
  if (width === null || height === null || density === null || top === null || right === null || bottom === null || left === null) return null;
  return parseScreenMetrics({ width, height, density, insets: { top, right, bottom, left } });
}

/** Native -> overlay page. null: refused. */
export function parseOverlayInbound(text: unknown): OverlayInbound | null {
  const o = parseJson(text);
  if (!o) return null;
  switch (o.t) {
    case 'metrics': {
      if (!hasOnly(o, ['t', 'metrics'])) return null;
      const metrics = parseScreenMetrics(o.metrics);
      return metrics ? { t: 'metrics', metrics } : null;
    }
    case 'ptr': {
      if (!hasOnly(o, ['t', 'k', 'id', 'x', 'y', 'ms'])) return null;
      const k = POINTER_KINDS.find((p) => p === o.k);
      const id = num(o.id, 0, 1_000_000);
      const x = num(o.x, -LIMIT_DP, LIMIT_DP);
      const y = num(o.y, -LIMIT_DP, LIMIT_DP);
      const ms = num(o.ms, 0, 1e13);
      if (!k || id === null || !Number.isInteger(id) || x === null || y === null || ms === null) return null;
      return { t: 'ptr', k, id, x, y, ms };
    }
    case 'hint': {
      if (!hasOnly(o, ['t', 'x', 'y'])) return null;
      const x = num(o.x, -LIMIT_DP, LIMIT_DP);
      const y = num(o.y, -LIMIT_DP, LIMIT_DP);
      return x === null || y === null ? null : { t: 'hint', x, y };
    }
    case 'cmd': {
      if (!hasOnly(o, ['t', 'c'])) return null;
      const c = OVERLAY_COMMANDS.find((p) => p === o.c);
      return c ? { t: 'cmd', c } : null;
    }
    default:
      return null;
  }
}

/** Overlay page -> native, the string to post. */
export function serializeOverlayOutbound(m: OverlayOutbound): string {
  return JSON.stringify(m);
}

/** Overlay page -> native, as native parses it (the Kotlin side mirrors these rules; tests use this one). */
export function parseOverlayOutbound(text: unknown): OverlayOutbound | null {
  const o = parseJson(text);
  if (!o) return null;
  switch (o.t) {
    case 'hello': {
      if (!hasOnly(o, ['t', 'v'])) return null;
      const v = num(o.v, 0, 1000);
      return v === null ? null : { t: 'hello', v };
    }
    case 'win': {
      if (!hasOnly(o, ['t', 'x', 'y', 'w', 'h', 'vis', 'touch', 'tx', 'ty', 'tw', 'th'])) return null;
      const x = num(o.x, -LIMIT_DP, LIMIT_DP);
      const y = num(o.y, -LIMIT_DP, LIMIT_DP);
      const w = num(o.w, 1, LIMIT_DP);
      const h = num(o.h, 1, LIMIT_DP);
      const tx = num(o.tx, -LIMIT_DP, LIMIT_DP);
      const ty = num(o.ty, -LIMIT_DP, LIMIT_DP);
      const tw = num(o.tw, 1, LIMIT_DP);
      const th = num(o.th, 1, LIMIT_DP);
      if (x === null || y === null || w === null || h === null || tx === null || ty === null || tw === null || th === null) return null;
      if (typeof o.vis !== 'boolean' || typeof o.touch !== 'boolean') return null;
      return { t: 'win', x, y, w, h, vis: o.vis, touch: o.touch, tx, ty, tw, th };
    }
    case 'saved':
      return hasOnly(o, ['t', 'ok']) && typeof o.ok === 'boolean' ? { t: 'saved', ok: o.ok } : null;
    default:
      return null;
  }
}

/** App page -> native. */
export function serializeControlOp(op: ControlOp): string {
  return JSON.stringify({ t: 'op', op });
}

export function parseControlOp(text: unknown): ControlOp | null {
  const o = parseJson(text);
  if (!o || o.t !== 'op' || !hasOnly(o, ['t', 'op'])) return null;
  return CONTROL_OPS.find((p) => p === o.op) ?? null;
}

/** Native -> app page. */
export function parseFloatingState(text: unknown): FloatingState | null {
  const o = parseJson(text);
  if (!o || o.t !== 'state') return null;
  if (!hasOnly(o, ['t', 'running', 'paused', 'hidden', 'overlayPermission', 'notifications', 'canAskNotifications', 'lastStop'])) return null;
  const lastStop = STOP_REASONS.find((r) => r === o.lastStop);
  if (
    typeof o.running !== 'boolean' ||
    typeof o.paused !== 'boolean' ||
    typeof o.hidden !== 'boolean' ||
    typeof o.overlayPermission !== 'boolean' ||
    typeof o.notifications !== 'boolean' ||
    typeof o.canAskNotifications !== 'boolean' ||
    !lastStop
  ) {
    return null;
  }
  return {
    running: o.running,
    paused: o.paused,
    hidden: o.hidden,
    overlayPermission: o.overlayPermission,
    notifications: o.notifications,
    canAskNotifications: o.canAskNotifications,
    lastStop,
  };
}
