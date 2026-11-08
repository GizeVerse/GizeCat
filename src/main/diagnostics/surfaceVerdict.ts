// The one-sentence answer to "why is my cat (not) leaving the floor?", shown on top of
// the Diagnostics page's Surfaces section and logged as a code in the 'surfaces summary'
// line. Pure: counts, kinds and reasons in, plain English out (no titles, ids or names).
import type { DecisionDiagnostics, NavDiagnostics, NavRejectReason, ProviderDiagnostics, ProviderSkipReason, SurfaceCounts } from '../../shared/surfaceDiagnostics';
import type { SurfaceKind, SurfaceStatus } from '../../shared/surfaces';

/**
 * Priority order: the first that applies is the verdict. 'noWayUp' is decided in two places:
 * right after 'noneAccepted' when the cat knows window sides but no top or tab strip at all,
 * and after 'cooldown' when the last look found no way up from what it can reach.
 */
export const SURFACE_VERDICT_CODES = [
  'observersUnavailable',
  'elevated',
  'frontMaximized',
  'nothingListed',
  'noneAccepted',
  'noWayUp',
  'noneReachable',
  'switchedOff',
  'cooldown',
  'exploring',
] as const;
export type SurfaceVerdictCode = (typeof SURFACE_VERDICT_CODES)[number];

export interface SurfaceVerdictInput {
  /** The window-surface observer (SurfaceStatus.windowSurfaces): without it only the floor and taskbars are known. */
  observers: SurfaceStatus['windowSurfaces'];
  /** 1.4.0: this platform has no window tracking at all (every platform but Windows), so the cat keeps to the floor. */
  floorOnly?: boolean;
  provider: Pick<ProviderDiagnostics, 'windowsConsidered' | 'skipped' | 'listed' | 'frontMaximized'>;
  nav: Pick<NavDiagnostics, 'accepted' | 'rejected' | 'reachable'>;
  decision: Pick<DecisionDiagnostics, 'support' | 'targets' | 'exploreUrge'>;
}

export interface SurfaceVerdict {
  code: SurfaceVerdictCode;
  text: string;
}

/** The kinds that take the cat off the floor (taskbars sit on it). */
const ELEVATED_KINDS = ['windowTop', 'windowSide', 'tabStrip'] as const satisfies readonly SurfaceKind[];

export const FLOOR_ONLY_TEXT = 'The cat keeps to the floor here: this platform does not track other windows.';

export const FRONT_MAXIMIZED_TEXT =
  'The window in front is maximized, so there is no window edge to climb. Restore it to a normal window and the cat can explore it.';

const SKIP_TEXT: Record<ProviderSkipReason, string> = {
  maximized: 'the open windows are maximized, so they have no edges to climb',
  minimized: 'the open windows are minimized',
  fullscreen: 'the open windows are full screen',
  coversWorkArea: 'the open windows cover the whole screen, so they have no edges to climb',
  covered: 'every window edge is hidden behind other windows',
  excluded: 'the open windows belong to apps excluded in Settings › Privacy',
  tooSmall: 'the open windows are too small to stand on',
  offScreen: 'the open windows are off screen',
  disabled: 'window surfaces are switched off',
};

const REJECT_TEXT: Record<NavRejectReason, string> = {
  invalid: 'their position could not be read',
  offDisplay: 'they are off screen',
  noHeadroom: 'there is no room above them for the cat',
  nearFloor: 'they are too close to the floor',
  tooNarrow: 'they are too narrow to stand on',
  unsupportedEdge: 'they are taskbars on an edge the cat cannot stand on',
  noRoomBeside: 'there is no room beside the window sides for the cat to hang',
  tooShort: 'the window sides are too short to climb',
  disabled: 'climbing and sitting on windows are switched off in Settings › Behaviour',
  excluded: 'they belong to apps excluded in Settings › Privacy',
  capped: 'there are more than the cat can keep track of',
};

const KIND_WORDS: Record<(typeof ELEVATED_KINDS)[number], [string, string]> = {
  windowTop: ['window top', 'window tops'],
  windowSide: ['window side', 'window sides'],
  tabStrip: ['tab strip', 'tab strips'],
};

const n0 = (v: number): number => (Number.isFinite(v) ? Math.max(0, v) : 0);
const elevatedTotal = (c: SurfaceCounts): number => ELEVATED_KINDS.reduce((n, k) => n + n0(c[k]), 0);
/** Surfaces the cat can stand on up there (a side only leads to one). */
const topsTotal = (c: SurfaceCounts): number => n0(c.windowTop) + n0(c.tabStrip);

const NO_TOP_TEXT = 'none leads to a window top it can stand on (the tops have no room above them or are not usable)';
/**
 * A way up the decision can take, or may soon: 'notGrounded' means the last look happened in
 * mid-air or on a side, so it says nothing about the way up from the floor.
 */
const WAY_UP: ReadonlySet<string> = new Set(['available', 'cooldown', 'notGrounded']);

/** The reason with the highest count (ties: the earlier one in `order`), or null when none counts. */
function topReason<R extends string>(counts: Partial<Record<R, number>>, order: readonly R[]): R | null {
  let best: R | null = null;
  let bestN = 0;
  for (const r of order) {
    const n = counts[r] ?? 0;
    if (Number.isFinite(n) && n > bestN) {
      best = r;
      bestN = n;
    }
  }
  return best;
}

const plural = (n: number, [one, many]: [string, string]): string => `${n} ${n === 1 ? one : many}`;

/** "2 window tops, 1 window side and 1 tab strip" (kinds with a zero count left out). */
export function describeCounts(c: SurfaceCounts): string {
  const parts = ELEVATED_KINDS.filter((k) => c[k] > 0).map((k) => plural(c[k], KIND_WORDS[k]));
  if (parts.length === 0) return 'no window edges';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

const SKIP_ORDER = Object.keys(SKIP_TEXT) as ProviderSkipReason[];
const REJECT_ORDER = Object.keys(REJECT_TEXT) as NavRejectReason[];

export function surfaceVerdict(d: SurfaceVerdictInput): SurfaceVerdict {
  if (d.observers === 'unavailable') {
    return { code: 'observersUnavailable', text: d.floorOnly === true ? FLOOR_ONLY_TEXT : 'Window tracking is unavailable on this PC, so the cat only knows the floor and the taskbar.' };
  }
  const support = d.decision.support;
  if (support === 'windowTop' || support === 'windowSide' || support === 'tabStrip') {
    const where = support === 'windowSide' ? 'climbing a window side' : support === 'tabStrip' ? 'up on a browser tab strip' : 'up on a window top';
    return { code: 'elevated', text: `The cat is ${where} right now.` };
  }
  const listed = elevatedTotal(d.provider.listed);
  if (listed === 0 && d.provider.frontMaximized) return { code: 'frontMaximized', text: FRONT_MAXIMIZED_TEXT };
  if (listed === 0) {
    if (d.provider.windowsConsidered <= 0) return { code: 'nothingListed', text: 'No app windows are open, so there is nothing to climb besides the floor.' };
    const why = topReason(d.provider.skipped, SKIP_ORDER);
    return { code: 'nothingListed', text: `There are no window edges to climb right now: ${why ? SKIP_TEXT[why] : 'no window offers an edge the cat can use'}.` };
  }
  if (elevatedTotal(d.nav.accepted) === 0) {
    const why = topReason(d.nav.rejected, REJECT_ORDER);
    const edges = listed === 1 ? '1 window edge' : `${listed} window edges`;
    return { code: 'noneAccepted', text: `The cat sees ${edges} but can't use any of them: ${why ? REJECT_TEXT[why] : 'none passed its safety checks'}.` };
  }
  // Window sides alone lead nowhere: every way up ends on a top or a tab strip.
  if (topsTotal(d.nav.accepted) === 0) {
    return { code: 'noWayUp', text: `The cat knows ${describeCounts(d.nav.accepted)}, but ${NO_TOP_TEXT}.` };
  }
  if (elevatedTotal(d.nav.reachable) === 0) {
    return {
      code: 'noneReachable',
      text: `The cat knows ${describeCounts(d.nav.accepted)} but can't reach any from where it is: they are too high to jump to and no window side comes down close enough to climb.`,
    };
  }
  const t = d.decision.targets;
  if (t.perch === 'disabled' && t.climb === 'disabled' && t.tabStrip === 'disabled') {
    return { code: 'switchedOff', text: 'Sitting on windows, climbing them and walking on tab strips are all switched off in Settings › Behaviour.' };
  }
  const available = t.perch === 'available' || t.climb === 'available' || t.tabStrip === 'available';
  if (!available && (t.perch === 'cooldown' || t.climb === 'cooldown' || t.tabStrip === 'cooldown')) {
    return { code: 'cooldown', text: 'The cat explored recently and is taking a break before its next trip up.' };
  }
  if (!WAY_UP.has(t.perch) && !WAY_UP.has(t.climb) && !WAY_UP.has(t.tabStrip)) {
    // What it reaches does not take it up (e.g. the sides of a window whose top is at the screen's top edge).
    const reach = describeCounts(d.nav.reachable);
    return {
      code: 'noWayUp',
      text:
        topsTotal(d.nav.reachable) === 0
          ? `The cat can reach ${reach}, but ${NO_TOP_TEXT}.`
          : `The cat can reach ${reach} from where it is, but none of them is a way up it can use right now.`,
    };
  }
  const urge = Math.round((Number.isFinite(d.decision.exploreUrge) ? Math.min(1, Math.max(0, d.decision.exploreUrge)) : 0) * 100);
  return { code: 'exploring', text: `The cat can reach ${describeCounts(d.nav.reachable)} from where it is; its urge to explore is ${urge}%.` };
}
