// What the overlay windows need from the shell (ADR 0002 §2):
// - NonRudeHWND: a full-monitor transparent topmost window is otherwise treated as a fullscreen
//   ("rude") app and Explorer strips WS_EX_TOPMOST from Shell_TrayWnd within ~60 ms, so the
//   auto-hide reveal strip stops hit-testing as the taskbar (measured, taskbar.md §1). The
//   undocumented property exempts the window; SetPropW requires removing it before destroy.
// - TaskbarCreated: the registered message Explorer broadcasts to top-level windows after it
//   (re)creates the taskbar; the taskbar tracker then rediscovers the new window handles.
import { loadShellNative, type Hwnd, type ShellNative } from '../native';

export const NON_RUDE_PROP = 'NonRudeHWND';
export const TASKBAR_CREATED_MESSAGE = 'TaskbarCreated';

export interface OverlayShellNative {
  /** SetPropW(h, NonRudeHWND, 1); false when the call failed. */
  setNonRude(h: Hwnd): boolean;
  /** RemovePropW(h, NonRudeHWND); true when the property was present. */
  clearNonRude(h: Hwnd): boolean;
  /** RegisterWindowMessageW('TaskbarCreated'); null on failure. */
  taskbarCreatedMessage(): number | null;
}

export function createOverlayShellNative(shell: Pick<ShellNative, 'setProp' | 'removeProp' | 'registerWindowMessage'>): OverlayShellNative {
  let message: number | null = null;
  return {
    setNonRude: (h) => shell.setProp(h, NON_RUDE_PROP, 1),
    clearNonRude: (h) => shell.removeProp(h, NON_RUDE_PROP) !== 0,
    taskbarCreatedMessage() {
      if (message === null) {
        const id = shell.registerWindowMessage(TASKBAR_CREATED_MESSAGE);
        message = id >= 0xc000 && id <= 0xffff ? id : null;
      }
      return message;
    },
  };
}

/** The koffi-backed implementation. Throws when Win32 or the shell bindings are unavailable. */
export function loadOverlayShellNative(): OverlayShellNative {
  return createOverlayShellNative(loadShellNative());
}
