// The app screen's controls for the floating cat (Android app only; 1.4.0 preview 2). The elements
// live in index.html and are hidden everywhere else; this module shows them from the state native
// pushes (floatingProtocol.ts FloatingState) and turns clicks into control operations.
//
// - First use: "Float over apps" with no overlay permission opens an explanation (what the permission
//   is, what the app does and does not do with it) with a button that asks native to open Android's
//   own settings page. The page never opens it by itself, and "Not now" is final for this page load:
//   nothing asks again until the user taps "Float over apps" again.
// - Coming back from Android's settings with the permission granted starts the cat (the user's tap
//   on Start still stands); without it, one calm line says so and the app stays fully usable.
// - While the cat floats, the app's own cat is parked (main.ts) and these buttons pause, hide and stop it.
//
// DOM access only through the elements passed in; no timers, no storage.
import type { ControlPort } from './floatingBridges';
import { NO_FLOATING, type FloatingState } from './floatingProtocol';
import { WS } from './strings';

export interface FloatingElements {
  start: HTMLButtonElement;
  pause: HTMLButtonElement;
  hide: HTMLButtonElement;
  stop: HTMLButtonElement;
  /** The permission explanation panel (a section with the text paragraphs and two buttons). */
  ask: HTMLElement;
  askText: HTMLElement;
  askOpen: HTMLButtonElement;
  askLater: HTMLButtonElement;
  /** A polite status line. */
  status: HTMLElement;
}

export interface FloatingUiDeps {
  els: FloatingElements;
  control: ControlPort;
  catName: () => string;
  /** The user asked to start: the page writes its cat to storage first, so the floating cat begins from it. */
  beforeStart: () => void;
  /** The cat now floats (true) or no longer does (false after it did): main.ts parks or reloads the app's own cat. */
  onRunningChange: (running: boolean) => void;
}

export interface FloatingUi {
  /** A fresh state from native. */
  update(state: FloatingState): void;
  readonly state: FloatingState;
}

export function createFloatingUi(deps: FloatingUiDeps): FloatingUi {
  const { els, control } = deps;
  let state: FloatingState = NO_FLOATING;
  let known = false;
  let running = false;
  /** The user tapped Start and went to Android's settings: start by itself when they come back with the permission. */
  let pendingStart = false;
  /** The page was hidden after the tap (Android's settings page opened over it). */
  let leftForSettings = false;
  /** Android's settings were closed without the permission: one calm line, until the user taps Start again. */
  let pendingStartDenied = false;

  for (const text of WS.floating.askText) els.askText.append(Object.assign(document.createElement('p'), { textContent: text }));
  els.start.textContent = WS.floating.start;
  els.stop.textContent = WS.floating.stop;
  els.askOpen.textContent = WS.floating.askOpen;
  els.askLater.textContent = WS.floating.askLater;
  els.ask.setAttribute('aria-labelledby', 'floating-ask-title');
  const title = els.ask.querySelector('#floating-ask-title');
  if (title) title.textContent = WS.floating.askTitle;

  function begin(): void {
    deps.beforeStart();
    control.send('start');
  }

  els.start.addEventListener('click', () => {
    if (!known) {
      control.send('query');
      return;
    }
    if (state.overlayPermission) {
      begin();
      return;
    }
    // The explanation first; Android's page opens only from its own button.
    pendingStart = false;
    els.ask.hidden = false;
    els.askOpen.focus();
  });
  els.askOpen.addEventListener('click', () => {
    pendingStart = true;
    leftForSettings = false;
    els.ask.hidden = true;
    control.send('openOverlaySettings');
  });
  // Android's settings page covers the app: the page goes hidden, then visible again on return. Only
  // the state pushed after that return decides (a push right after the tap says "still missing").
  document.addEventListener('visibilitychange', () => {
    if (pendingStart && document.visibilityState === 'hidden') leftForSettings = true;
  });
  els.askLater.addEventListener('click', () => {
    pendingStart = false;
    els.ask.hidden = true;
    render();
  });
  els.pause.addEventListener('click', () => control.send(state.paused ? 'resume' : 'pause'));
  els.hide.addEventListener('click', () => control.send(state.hidden ? 'show' : 'hide'));
  els.stop.addEventListener('click', () => control.send('stop'));

  function statusText(): string {
    const name = deps.catName();
    if (state.running) {
      const lines = [state.hidden ? WS.floating.runningHidden(name) : state.paused ? WS.floating.runningPaused(name) : WS.floating.running(name)];
      if (!state.notifications) lines.push(WS.floating.noNotifications);
      return lines.join(' ');
    }
    // Until the next start: native clears the reason when a start begins.
    if (state.lastStop !== 'none' && state.lastStop !== 'user') return WS.floating.stopped[state.lastStop];
    if (pendingStartDenied) return WS.floating.idleDenied;
    return '';
  }

  function render(): void {
    els.start.hidden = !known || state.running;
    els.pause.hidden = !state.running;
    els.hide.hidden = !state.running;
    els.stop.hidden = !state.running;
    els.pause.textContent = state.paused ? WS.floating.resume : WS.floating.pause;
    els.hide.textContent = state.hidden ? WS.floating.show : WS.floating.hide;
    if (state.running) els.ask.hidden = true;
    const text = statusText();
    els.status.textContent = text;
    els.status.hidden = text === '';
  }

  return {
    update(next) {
      state = next;
      known = true;
      if (pendingStart && next.overlayPermission && !next.running) {
        // Back from Android's settings with the permission: the user's tap on Start now takes effect.
        pendingStart = false;
        pendingStartDenied = false;
        begin();
      } else if (pendingStart && leftForSettings) {
        // Back without the permission (or already running): one calm line, nothing asks again.
        pendingStart = false;
        pendingStartDenied = !next.overlayPermission;
      } else if (!pendingStart && next.overlayPermission) {
        pendingStartDenied = false;
      }
      if (next.running !== running) {
        running = next.running;
        deps.onRunningChange(running);
      }
      render();
    },
    get state() {
      return state;
    },
  };
}
