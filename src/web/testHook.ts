// Test build only (out/web-test, built with --web-test): a read-only window.__gizecatWebTest for the
// Playwright suite (tests/web). The production build (out/web) never contains this module: main.ts
// installs it behind the __WEB_TEST__ build constant, so esbuild drops it; a build check and a test
// scan out/web for the hook's name.
import type { BehaviorState } from '../shared/cat';
import type { Point, Rect } from '../shared/geometry';
import type { SimEvent } from '../shared/sim';
import type { CatHost } from '../main/catHost';
import type { PointerRouter } from './pointerRouter';
import type { CatSource, WebStorage } from './storage';
import type { WebOverlays } from './webOverlays';

const HISTORY = 64;

export interface WebTestSources {
  host: CatHost;
  overlays: WebOverlays;
  router: PointerRouter;
  storage: WebStorage;
  catSource: CatSource;
  catId: () => string;
  suspended: () => boolean;
}

export interface WebTestState {
  behavior: BehaviorState;
  /** Behaviour states as they changed, oldest first (the last HISTORY). */
  states: BehaviorState[];
  anchor: Point | null;
  /** The sim's bounds (CSS px), null while the cat is not shown. */
  bounds: Rect | null;
  /** The hit region in use (CSS px). */
  hitRects: Rect[];
  visible: boolean;
  hidden: boolean;
  paused: boolean;
  suspended: boolean;
  ticks: number;
  timeScale: number;
  reaction: { kind: string; at: number } | null;
  /** Sim events the pointer router delivered (gestures), in total and per type. */
  simEvents: number;
  eventCounts: Record<string, number>;
  router: { hovering: boolean; pressed: boolean; dragging: boolean; touchMode: string | null };
  overlay: { ready: boolean; active: boolean; renders: number; hitReports: number; rendererErrors: number };
  storage: { available: boolean; catSource: CatSource; saves: number; failures: number; catId: string };
}

export interface WebTestHook {
  readonly version: 1;
  state(): WebTestState;
  /** Speeds the simulation up (0.1 to 100). */
  setTimeScale(scale: number): void;
  /** Whether a press at (x, y) (CSS px) would go to the cat right now (the router's hit test; read-only). */
  catAt(x: number, y: number): boolean;
}

export interface WebTestRecorder {
  noteEvents(events: readonly SimEvent[]): void;
  noteState(state: BehaviorState): void;
}

export function installTestHook(target: object, src: WebTestSources): WebTestRecorder {
  const states: BehaviorState[] = [];
  const counts: Record<string, number> = {};
  let total = 0;

  const hook: WebTestHook = Object.freeze({
    version: 1 as const,
    state(): WebTestState {
      const out = src.host.lastOutput;
      const region = src.overlays.effectiveRegion();
      const o = src.overlays.debug();
      const st = src.storage.stats;
      return {
        behavior: src.host.state,
        states: [...states],
        anchor: src.host.catAnchor(),
        bounds: src.host.catBoundsPx(),
        hitRects: region.rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
        visible: out?.visible ?? false,
        hidden: src.host.hidden,
        paused: src.host.paused,
        suspended: src.suspended(),
        ticks: src.host.debug().ticks,
        timeScale: src.host.timeScale,
        reaction: out?.reaction ? { kind: out.reaction.kind, at: out.reaction.at } : null,
        simEvents: total,
        eventCounts: { ...counts },
        router: { hovering: src.router.hovering, pressed: src.router.pressed, dragging: src.router.dragging, touchMode: src.router.touchMode },
        overlay: { ready: o.ready, active: o.active, renders: o.renders, hitReports: o.hitReports, rendererErrors: o.rendererErrors },
        storage: { available: src.storage.available, catSource: src.catSource, saves: st.saves, failures: st.failures, catId: src.catId() },
      };
    },
    setTimeScale(scale: number): void {
      if (typeof scale === 'number' && Number.isFinite(scale)) src.host.setTimeScale(scale);
    },
    catAt(x: number, y: number): boolean {
      return src.overlays.hitTest({ x: Number(x), y: Number(y) }, false);
    },
  });
  Object.defineProperty(target, '__gizecatWebTest', { value: hook, writable: false, enumerable: false, configurable: false });

  return {
    noteEvents(events) {
      for (const ev of events) {
        total++;
        counts[ev.type] = (counts[ev.type] ?? 0) + 1;
      }
    },
    noteState(state) {
      if (states[states.length - 1] === state) return;
      states.push(state);
      if (states.length > HISTORY) states.shift();
    },
  };
}
