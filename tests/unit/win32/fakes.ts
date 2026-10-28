// Test doubles for the Win32 layer: a fake native binding (for win32Api) and a fake
// Win32Api (for the tracker / activity monitor). Deterministic, no FFI.
import type { Point, Rect } from '../../../src/shared/geometry';
import type { WindowInfo } from '../../../src/shared/world';
import type { Logger, RawWinEvent, Unsubscribe, Win32Api } from '../../../src/main/contracts';
import type { Hwnd, RawRect, Win32Native, WinEventProc } from '../../../src/main/win32/native';
import type { ExtendedWin32Api } from '../../../src/main/win32/win32Api';

export interface LogEntry {
  level: 'error' | 'warn' | 'info' | 'debug';
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export function createTestLogger(entries: LogEntry[] = [], scope = 'test'): Logger & { entries: LogEntry[] } {
  const make = (s: string): Logger & { entries: LogEntry[] } => ({
    entries,
    error: (msg, data) => entries.push({ level: 'error', scope: s, msg, data }),
    warn: (msg, data) => entries.push({ level: 'warn', scope: s, msg, data }),
    info: (msg, data) => entries.push({ level: 'info', scope: s, msg, data }),
    debug: (msg, data) => entries.push({ level: 'debug', scope: s, msg, data }),
    child: (c) => make(`${s}.${c}`),
  });
  return make(scope);
}

export const raw = (x: number, y: number, w: number, h: number): RawRect => ({ left: x, top: y, right: x + w, bottom: y + h });

export interface FakeWindow {
  pid: number;
  visible?: boolean;
  /** GA_ROOT result; defaults to the window itself. */
  root?: Hwnd;
  exStyle?: number;
  style?: number;
  owner?: Hwnd;
  cloaked?: number;
  className?: string;
  title?: string;
  iconic?: boolean;
  zoomed?: boolean;
  frame?: RawRect | null;
  windowRect?: RawRect | null;
  monitor?: { monitor: RawRect; work: RawRect } | null;
  coreChild?: Hwnd;
}

export const PRIMARY_MONITOR = { monitor: raw(0, 0, 1920, 1200), work: raw(0, 0, 1920, 1152) };

export class FakeNative implements Win32Native {
  readonly ownPid: number;
  windows = new Map<Hwnd, FakeWindow>();
  zOrder: Hwnd[] = [];
  processes = new Map<number, string>();
  cursor: { x: number; y: number } | null = { x: 10, y: 10 };
  lastInputTick: number | null = 1000;
  tick = 1500;
  keyState = new Map<number, number>();
  swapButtons = false;
  foreground: Hwnd | null = null;
  pointWindow: Hwnd | null = null;
  quns: number | null = 5;
  dpi: number | null = 2;
  failHooks = new Set<number>();
  throwOn = new Set<keyof Win32Native>();

  imageLookups = 0;
  titleReads: Hwnd[] = [];
  procs = new Map<bigint, WinEventProc>();
  hooks = new Map<bigint, { min: number; max: number; proc: bigint; flags: number }>();
  unhooked: bigint[] = [];
  unregistered: bigint[] = [];
  private nextPtr = 0x1000n;

  constructor(ownPid = 4242) {
    this.ownPid = ownPid;
  }

  add(h: Hwnd, w: FakeWindow, path = `C:\\Apps\\App${w.pid}.exe`): this {
    this.windows.set(h, { visible: true, exStyle: 0, style: 0x00cf0000, cloaked: 0, className: 'AppWindow', title: '', frame: raw(100, 100, 800, 600), ...w });
    this.zOrder.push(h);
    if (!this.processes.has(w.pid)) this.processes.set(w.pid, path);
    return this;
  }

  /** Fires a WinEvent into every registered proc. */
  fire(event: number, hwnd: Hwnd | null, idObject = 0, idChild = 0): void {
    for (const proc of this.procs.values()) proc(event, hwnd, idObject, idChild);
  }

  private w(h: Hwnd): FakeWindow | undefined {
    return this.windows.get(h);
  }

  private check(name: keyof Win32Native): void {
    if (this.throwOn.has(name)) throw new Error(`boom: ${name}`);
  }

  getCursorPos() {
    this.check('getCursorPos');
    return this.cursor;
  }
  getLastInputTick() {
    return this.lastInputTick;
  }
  getTickCount() {
    return this.tick;
  }
  getAsyncKeyState(vk: number) {
    return this.keyState.get(vk) ?? 0;
  }
  getSystemMetrics(index: number) {
    return index === 23 && this.swapButtons ? 1 : 0;
  }
  getForegroundWindow() {
    return this.foreground;
  }
  getAncestor(h: Hwnd) {
    const w = this.w(h);
    return w ? (w.root ?? h) : null;
  }
  getWindow(h: Hwnd) {
    return this.w(h)?.owner ?? null;
  }
  getWindowProcessId(h: Hwnd) {
    this.check('getWindowProcessId');
    return this.w(h)?.pid ?? 0;
  }
  getProcessImagePath(pid: number) {
    this.imageLookups++;
    return this.processes.get(pid) ?? null;
  }
  getWindowText(h: Hwnd) {
    this.titleReads.push(h);
    return this.w(h)?.title ?? '';
  }
  getClassName(h: Hwnd) {
    return this.w(h)?.className ?? '';
  }
  isWindow(h: Hwnd) {
    return this.windows.has(h);
  }
  isWindowVisible(h: Hwnd) {
    return this.w(h)?.visible === true;
  }
  isIconic(h: Hwnd) {
    return this.w(h)?.iconic === true;
  }
  isZoomed(h: Hwnd) {
    return this.w(h)?.zoomed === true;
  }
  getWindowLong(h: Hwnd, index: number) {
    const w = this.w(h);
    if (!w) return 0;
    return index === -20 ? (w.exStyle ?? 0) : (w.style ?? 0);
  }
  getExtendedFrameBounds(h: Hwnd) {
    return this.w(h)?.frame ?? null;
  }
  getWindowRect(h: Hwnd) {
    const w = this.w(h);
    if (!w) return null;
    return w.windowRect !== undefined ? w.windowRect : (w.frame ?? null);
  }
  getCloaked(h: Hwnd) {
    const w = this.w(h);
    return w ? (w.cloaked ?? 0) : null;
  }
  findChildWindow(parent: Hwnd) {
    return this.w(parent)?.coreChild ?? null;
  }
  enumTopLevelWindows() {
    this.check('enumTopLevelWindows');
    return [...this.zOrder];
  }
  getMonitorRectsForWindow(h: Hwnd) {
    const w = this.w(h);
    if (!w) return null;
    return w.monitor !== undefined ? w.monitor : PRIMARY_MONITOR;
  }
  windowFromPoint() {
    return this.pointWindow;
  }
  queryUserNotificationState() {
    return this.quns;
  }
  getThreadDpiAwareness() {
    return this.dpi;
  }
  registerWinEventProc(proc: WinEventProc) {
    const ptr = this.nextPtr++;
    this.procs.set(ptr, proc);
    return ptr;
  }
  unregisterCallback(ptr: bigint) {
    this.unregistered.push(ptr);
    this.procs.delete(ptr);
  }
  setWinEventHook(min: number, max: number, proc: bigint, flags: number) {
    if (this.failHooks.has(min)) return null;
    const h = this.nextPtr++;
    this.hooks.set(h, { min, max, proc, flags });
    return h;
  }
  unhookWinEvent(hook: bigint) {
    this.unhooked.push(hook);
    return this.hooks.delete(hook);
  }
}

export const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

export function win(id: string, r: Rect, patch: Partial<WindowInfo> = {}): WindowInfo {
  return { id, rect: r, processName: 'app.exe', category: 'other', minimized: false, maximized: false, fullscreen: false, excluded: false, ...patch };
}

/** Scriptable Win32Api for tracker tests. `windows` is kept in z-order, top first. */
export class FakeWin32Api implements Win32Api {
  available = true;
  hooksAvailable = true;
  windows: WindowInfo[] = [];
  foregroundId: string | null = null;
  notification: ReturnType<Win32Api['getNotificationState']> = 'normal';
  cursor: Point | null = { x: 0, y: 0 };
  idle: number | null = 0;
  leftDown = false;
  handler: ((ev: RawWinEvent) => void) | null = null;
  listCalls = 0;
  describeCalls = 0;
  unsubscribed = 0;
  extraRects = new Map<string, Rect>();

  find(id: string): WindowInfo | undefined {
    return this.windows.find((w) => w.id === id);
  }
  add(w: WindowInfo, atTop = true): this {
    if (atTop) this.windows.unshift(w);
    else this.windows.push(w);
    return this;
  }
  remove(id: string): void {
    this.windows = this.windows.filter((w) => w.id !== id);
  }
  update(id: string, patch: Partial<WindowInfo>): void {
    this.windows = this.windows.map((w) => (w.id === id ? { ...w, ...patch } : w));
  }
  fire(kind: RawWinEvent['kind'], id: string, at = 0): void {
    this.handler?.({ kind, id, at });
  }

  getCursorPos() {
    return this.cursor;
  }
  getIdleMs() {
    return this.idle;
  }
  isLeftButtonDown() {
    return this.leftDown;
  }
  getForegroundWindowId() {
    return this.foregroundId;
  }
  describeWindow(id: string) {
    this.describeCalls++;
    const w = this.find(id);
    return w ? { ...w } : null;
  }
  getWindowRect(id: string) {
    const w = this.find(id);
    if (w) return w.minimized ? null : { ...w.rect };
    return this.extraRects.get(id) ?? null;
  }
  listAppWindows() {
    this.listCalls++;
    return this.windows.map((w) => ({ ...w }));
  }
  windowIdAtPoint(p: Point) {
    const hit = this.windows.find((w) => !w.minimized && p.x >= w.rect.x && p.x < w.rect.x + w.rect.width && p.y >= w.rect.y && p.y < w.rect.y + w.rect.height);
    return hit?.id ?? null;
  }
  getNotificationState() {
    return this.notification;
  }
  subscribeWinEvents(handler: (ev: RawWinEvent) => void): Unsubscribe | null {
    if (!this.hooksAvailable) return null;
    this.handler = handler;
    return () => {
      this.unsubscribed++;
      this.handler = null;
    };
  }
  dispose() {
    this.handler = null;
  }
}

/** FakeWin32Api plus the title-aware exclusion extension. */
export class FakeExtendedWin32Api extends FakeWin32Api implements ExtendedWin32Api {
  exclusionCalls: Array<[readonly string[], readonly string[]]> = [];
  excludedIds = new Map<string, boolean | null>();
  setExclusions(processes: readonly string[], titlePatterns: readonly string[]) {
    this.exclusionCalls.push([processes, titlePatterns]);
  }
  isWindowExcluded(id: string) {
    return this.excludedIds.has(id) ? (this.excludedIds.get(id) ?? null) : false;
  }
}
