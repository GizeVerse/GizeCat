// Data-only shapes of the native Win32 layer (native.ts binds them with koffi). Kept apart from
// native.ts so modules that only need the types (win32Api.ts and its helpers) never pull koffi or
// Node typings into a program: the web host type-checks them with the DOM lib alone (ADR 0004 §8).
export type Hwnd = bigint;

export interface RawRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** WinEventProc as seen by JS (koffi also passes hook handle, thread id and time; unused). */
export type WinEventProc = (event: number, hwnd: Hwnd | null, idObject: number, idChild: number) => void;

export interface Win32Native {
  readonly ownPid: number;
  getCursorPos(): { x: number; y: number } | null;
  /** LASTINPUTINFO.dwTime (GetTickCount clock) or null on failure. */
  getLastInputTick(): number | null;
  getTickCount(): number;
  getAsyncKeyState(vk: number): number;
  getSystemMetrics(index: number): number;
  getForegroundWindow(): Hwnd | null;
  getAncestor(h: Hwnd, flags: number): Hwnd | null;
  getWindow(h: Hwnd, cmd: number): Hwnd | null;
  /** 0 when the window is gone. */
  getWindowProcessId(h: Hwnd): number;
  getProcessImagePath(pid: number): string | null;
  /** Caption of a window. Callers must only use it on windows of OTHER processes. */
  getWindowText(h: Hwnd): string;
  getClassName(h: Hwnd): string;
  isWindow(h: Hwnd): boolean;
  isWindowVisible(h: Hwnd): boolean;
  isIconic(h: Hwnd): boolean;
  isZoomed(h: Hwnd): boolean;
  /** GetWindowLongPtrW, normalised to an unsigned 32-bit value. */
  getWindowLong(h: Hwnd, index: number): number;
  getExtendedFrameBounds(h: Hwnd): RawRect | null;
  getWindowRect(h: Hwnd): RawRect | null;
  /** DWMWA_CLOAKED value (0 = not cloaked) or null when the query failed. */
  getCloaked(h: Hwnd): number | null;
  findChildWindow(parent: Hwnd, className: string): Hwnd | null;
  /** Top-level windows in z-order, top first. */
  enumTopLevelWindows(): Hwnd[];
  getMonitorRectsForWindow(h: Hwnd): { monitor: RawRect; work: RawRect } | null;
  windowFromPoint(x: number, y: number): Hwnd | null;
  /** QUERY_USER_NOTIFICATION_STATE value or null on failure. */
  queryUserNotificationState(): number | null;
  /** DPI_AWARENESS of the calling thread, or null when the API is missing. */
  getThreadDpiAwareness(): number | null;
  registerWinEventProc(proc: WinEventProc): bigint;
  unregisterCallback(ptr: bigint): void;
  /** `idProcess` (default 0 = every process) limits the hook to one process's events. */
  setWinEventHook(eventMin: number, eventMax: number, proc: bigint, flags: number, idProcess?: number): bigint | null;
  unhookWinEvent(hook: bigint): boolean;
}
