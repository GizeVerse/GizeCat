// X11 compositing-manager detection (ADR 0004 §5, review H3). Without a compositing manager a
// transparent full-work-area window can be drawn opaque and hide the desktop, so on X11 the
// overlay exists only while one runs. A compositing manager owns the selection
// _NET_WM_CM_S<screen> (EWMH, "Compositing Managers"). libX11 is bound lazily through koffi;
// any failure reports "unknown", which the caller treats as "no compositor" (fail closed).
import type * as koffiModule from 'koffi';

type Koffi = typeof koffiModule;

export type CompositorState = 'present' | 'absent' | 'unknown';

export interface CompositorProbe {
  /** Opens a display connection, asks for the selection owner and closes it again (about a millisecond). */
  check(): CompositorState;
  /** Why the last check could not answer, or null. */
  readonly error: string | null;
}

interface X11 {
  XOpenDisplay(name: null): unknown;
  XDefaultScreen(display: unknown): number;
  XInternAtom(display: unknown, name: string, onlyIfExists: number): bigint | number;
  XGetSelectionOwner(display: unknown, atom: bigint | number): bigint | number;
  XCloseDisplay(display: unknown): number;
}

function bindX11(): X11 {
  if (process.platform !== 'linux') throw new Error(`X11 is not available on ${process.platform}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as Koffi;
  const lib = koffi.load('libX11.so.6');
  return {
    XOpenDisplay: lib.func('void *XOpenDisplay(const char *name)') as X11['XOpenDisplay'],
    XDefaultScreen: lib.func('int XDefaultScreen(void *display)') as X11['XDefaultScreen'],
    XInternAtom: lib.func('unsigned long XInternAtom(void *display, const char *name, int only_if_exists)') as X11['XInternAtom'],
    XGetSelectionOwner: lib.func('unsigned long XGetSelectionOwner(void *display, unsigned long atom)') as X11['XGetSelectionOwner'],
    XCloseDisplay: lib.func('int XCloseDisplay(void *display)') as X11['XCloseDisplay'],
  };
}

/** The pure decision on top of the native answers (unit-tested). */
export function compositorFromOwner(owner: bigint | number | null): CompositorState {
  if (owner === null) return 'unknown';
  return BigInt(owner) === 0n ? 'absent' : 'present';
}

export function createX11CompositorProbe(bind: () => X11 = bindX11): CompositorProbe {
  let x11: X11 | null | undefined;
  let error: string | null = null;
  return {
    get error() {
      return error;
    },
    check() {
      if (x11 === undefined) {
        try {
          x11 = bind();
        } catch (e) {
          x11 = null;
          error = e instanceof Error ? e.message : String(e);
        }
      }
      if (!x11) return 'unknown';
      let display: unknown = null;
      try {
        display = x11.XOpenDisplay(null);
        if (!display) {
          error = 'XOpenDisplay failed';
          return 'unknown';
        }
        const screen = x11.XDefaultScreen(display);
        const atom = x11.XInternAtom(display, `_NET_WM_CM_S${screen}`, 0);
        const state = compositorFromOwner(x11.XGetSelectionOwner(display, atom));
        error = null;
        return state;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        return 'unknown';
      } finally {
        if (display) {
          try {
            x11.XCloseDisplay(display);
          } catch {
            /* the connection is gone either way */
          }
        }
      }
    },
  };
}

export const NO_COMPOSITOR_REASON =
  'No compositing window manager is running, so a transparent window could cover the desktop; the cat is not shown. Turn on compositing (for example in your window manager settings, or start picom) and the cat appears within a few seconds.';
