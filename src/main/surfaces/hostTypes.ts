// Host <-> surface-provider feedback shapes (data only). Kept apart from provider.ts so the cat host
// can name them without pulling the provider (Node, the UIA helper) into a program: the web host
// type-checks catHost.ts with the DOM lib alone (ADR 0004 §8). provider.ts re-exports both.

/** Where the cat is (px) and which surface it is attached to; fed by the host every tick. */
export interface CatPosition {
  x: number;
  y: number;
  surfaceId: string | null;
  /**
   * The user hid the cat. The sim keeps it on its surface meanwhile, so the attachment still
   * steers which span is served; nothing is of tab-strip interest.
   */
  hidden?: boolean;
  /**
   * The cat sleeps (or is falling asleep), is paused, or is away (out of sight for a fullscreen
   * app). It makes no trips then, so far browsers are not measured as possible destinations and
   * the tab-strip helper can idle; the one it is on and those within reach still are.
   */
  asleep?: boolean;
  paused?: boolean;
  away?: boolean;
}

/** The host's T8 screen-edge click guard as reported for the diagnostics (counts and a state only). */
export interface ScreenEdgeGuard {
  state: 'off' | 'idle' | 'active' | 'failClosed';
  /** Times the guard failed closed this session. */
  failClosed: number;
}
