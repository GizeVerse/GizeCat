// The page's first screen (1.4.0). index.html shows it before main.js runs, in CSS alone (web.css;
// the page allows no inline script), and the stylesheet itself reveals the failure message when
// nothing has ended the screen in time, which is what happens when main.js cannot load or the
// browser is too old to run it. This module only ends that screen once main.js is running.
//
// Structural types only, so it is unit-testable without a DOM.

export interface BootScreenLike {
  remove(): void;
  readonly classList: { add(name: string): void };
}

/** The cat started: the first screen goes. It could not: the failure message, at once. */
export function settleBootScreen(screen: BootScreenLike | null, started: boolean): void {
  if (!screen) return;
  if (started) screen.remove();
  else screen.classList.add('failed');
}
