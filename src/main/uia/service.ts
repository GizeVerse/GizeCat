// TabStripService (src/main/contracts.ts): browser tab strips as walkable ledges, read through the
// DesktopCatUia helper (geometry only; ADR 0002 §3).
//
// - Lazy: the helper starts only while the tabStrips toggle is on and an interesting Edge/Chrome
//   window exists (setInterest), and stops after `idleShutdownMs` without one.
// - Windows passed to setInterest are polled at 1 Hz (the cat is on or heading to them; tab rects
//   raise no change events); those passed as `slow` (far browsers that are only possible
//   destinations) every `slowPollIntervalMs`, and their window descriptions are refreshed at the
//   ordinary describeIntervalMs rather than the live rate. Windows that were of interest recently stay listed
//   and are refreshed only on helper events (tab selected, content structure changed) or when they
//   are resized, then dropped after `idleShutdownMs`.
// - Why a window of interest has no usable strip (maximized, no head room, vertical tabs, a
//   timeout...) is kept as a short code for the diagnostics (no ids, titles or names). Whether a
//   window can give one for now is answered per window (unusable), so the surface provider spends
//   its few far places on browsers that can.
// - Excluded (private) windows are never queried: the exclusion verdict is re-read right before
//   every request and an excluded window is dropped on sight.
// - A crashed, blocked or hung helper is restarted with exponential backoff; after too many
//   failures the service reports 'unavailable' with a reason (window tops keep working) and tries
//   one more start once the restart budget's window has passed.
// - A browser that stops responding (Not Responding, suspended) blocks the single-threaded helper
//   inside its UI Automation call. That is the window's fault, not the helper's: the window is
//   quarantined with a growing delay and the helper is replaced without it, outside the restart
//   budget, so the other windows keep their strips.
// All decisions use the injected clock; the optional internal timer only calls pump(now()).
//
// v1.2 (ADR 0003 §7.2, §7.3):
// - Which windows are read comes from the allow-list (allowList.ts): Edge, Chrome, Windows Terminal,
//   and File Explorer only once its soak passed. A strip whose reader kind differs from the rule's
//   is dropped (kind cross-check).
// - File Explorer is the shell's own process: at most one request per second and three windows, its
//   own timeout, read last in each cycle. Kill switch: a TaskbarCreated broadcast (the shell
//   restarted) within 10 min of any Explorer request turns Explorer off for the session; a second
//   one (counted in uia-health.json) turns it off until the next app version.
// - T6: a failed read keeps the last good strip for up to 10 s (confidence 0.5 -> 0.3), placed on the
//   window's current frame (the segment clamps it to the frame minus the caption buttons); it is
//   dropped at once on a width change of more than 4 px or a maximize, then the top is used as before.
import type { Point } from '../../shared/geometry';
import { disabledBehaviorSet, type Settings } from '../../shared/settings';
import type { SimEvent } from '../../shared/sim';
import type { LedgeSurface, SurfaceStatus } from '../../shared/surfaces';
import type { WindowInfo } from '../../shared/world';
import type { Logger, TabStripService } from '../contracts';
import { tabStripAppRule, tabStripRuleFor, type TabStripAppRule, type TabStripAppSlug, type TabStripRuleOverrides } from './allowList';
import { HelperTransportError, spawnUiaHelper, UiaHelperClient, type ChildProcessLike, type HelperExit } from './client';
import { createUiaHealth } from './health';
import { fromWireRect, HWND_PATTERN, stripKind, UIA_PROTOCOL_VERSION, type HelperEvent, type HelperRequest, type HelperResponse, type TabStripKind, type WireStrip } from './protocol';
import { DEFAULT_RESTART_BUDGET, RestartBudget, type RestartBudgetOptions } from './restartBudget';
import { catExtentPx, computeTabStripSegment, placeStrip, toRelativeStrip, type RelativeStrip, type SegmentDisabledReason, type StripGeometry, type TabStripSegment } from './segment';

export const tabStripSurfaceId = (hwnd: string): string => `tabStrip:${hwnd}`;

export interface TabStripServiceOptions {
  requestTimeoutMs: number;
  /** Refresh period for windows of interest. */
  pollIntervalMs: number;
  /** Refresh period for windows of interest passed as `slow` (far candidates). */
  slowPollIntervalMs: number;
  /** Helper stops (and retained windows are dropped) after this long without interest. */
  idleShutdownMs: number;
  /** Window descriptions (rect, maximized, exclusion) are re-read at most this often. */
  describeIntervalMs: number;
  /**
   * Max age of the window description used by surfaces() for windows of interest. The surface
   * provider shifts strips with their window between reads, so this only bounds how stale the
   * exclusion/maximized verdict and the reported position may get.
   */
  liveDescribeMs: number;
  /** At most one tabs.changed per window per this period (later changes are merged). */
  eventDebounceMs: number;
  /** Minimum gap between two reads of the same window after an event. */
  refreshGapMs: number;
  maxWindows: number;
  maxInterest: number;
  maxInFlight: number;
  /** Retry delay after a failed read of one window (doubles up to windowRetryMaxMs). */
  windowRetryMs: number;
  windowRetryMaxMs: number;
  /** Windows the helper rejected (not a browser frame) are skipped this long. */
  rejectedWindowMs: number;
  /**
   * A window whose browser stalled the helper (its request timed out, or the helper found it hung)
   * is not queried or watched for this long; doubles per stall up to stalledWindowMaxMs, and the
   * next answered read clears it.
   */
  stalledWindowMs: number;
  stalledWindowMaxMs: number;
  quitGraceMs: number;
  /** Internal pump timer period (ms); 0 disables it (tests drive pump through setInterest). */
  autoPumpMs: number;
  /** Helper failures (crash, spawn error, a hang outside any browser call). */
  restart: RestartBudgetOptions;
  /**
   * Helper replacements after a stalled browser window. They do not count as helper failures
   * until this allowance is used up (a helper that hangs on every window is still a broken helper).
   */
  stallRestart: RestartBudgetOptions;
  eventQueueCapacity: number;
  maxLineBytes: number;
  /**
   * Turns the File Explorer rule on although it ships off (EXPLORER_SOAK_PASSED). The REAL soak and
   * probes only; the kill switch still wins.
   */
  enableExplorerTabs: boolean;
  /** A TaskbarCreated broadcast this soon after an Explorer request trips the kill switch (ms). */
  explorerKillWindowMs: number;
  /** T6: how long a failed read keeps the last good strip listed (ms). */
  retainStripMs: number;
  /** T6: a frame width change beyond this (px) drops a retained strip at once. */
  retainWidthTolerancePx: number;
}

export const DEFAULT_TAB_STRIP_OPTIONS: TabStripServiceOptions = {
  requestTimeoutMs: 1500,
  pollIntervalMs: 1000,
  slowPollIntervalMs: 3000,
  idleShutdownMs: 60_000,
  describeIntervalMs: 250,
  liveDescribeMs: 50,
  eventDebounceMs: 300,
  refreshGapMs: 100,
  maxWindows: 8,
  maxInterest: 4,
  maxInFlight: 2,
  windowRetryMs: 2000,
  windowRetryMaxMs: 60_000,
  rejectedWindowMs: 10 * 60_000,
  stalledWindowMs: 30_000,
  stalledWindowMaxMs: 10 * 60_000,
  quitGraceMs: 2000,
  autoPumpMs: 500,
  restart: DEFAULT_RESTART_BUDGET,
  stallRestart: { baseDelayMs: 250, maxDelayMs: 8000, maxRestarts: 20, windowMs: 10 * 60_000 },
  eventQueueCapacity: 32,
  maxLineBytes: 64 * 1024,
  enableExplorerTabs: false,
  explorerKillWindowMs: 10 * 60_000,
  retainStripMs: 10_000,
  retainWidthTolerancePx: 4,
};

/** Retained-strip confidence at the failure and at the end of the retention (ADR 0003 §7.3). */
const RETAINED_CONFIDENCE_START = 0.5;
const RETAINED_CONFIDENCE_END = 0.3;

export interface TabStripServiceDeps {
  logger: Logger;
  settings: Settings;
  /** Path of DesktopCatUia.exe (resolveUiaHelperPath); null = not installed. */
  helperPath: string | null;
  /** Win32Api.describeWindow: rect, maximized, exclusion verdict. Titles never leave win32. */
  describeWindow: (id: string) => WindowInfo | null;
  /** Monotonic host clock (ms); defaults to performance.now. */
  now?: () => number;
  spawnHelper?: (path: string) => ChildProcessLike;
  /** Display attribution for surfaces; without it displayId is null (the surface provider may fill it). */
  displayAt?: (p: Point) => string | null;
  options?: Partial<TabStripServiceOptions>;
  /** uia-health.json in userData (the Explorer kill switch's strike counter); null/absent: in memory only. */
  healthFile?: string | null;
  /** The running app version (a strike limit reached disables Explorer until the version changes). */
  appVersion?: string;
}

type Change = Extract<SimEvent, { type: 'tabs.changed' }>['change'];
const CHANGE_PRIORITY: Record<Change, number> = { added: 3, removed: 3, selected: 2, geometry: 1 };

interface Snapshot {
  count: number;
  selectedIndex: number | null;
  focusRel: number | null;
  ok: boolean;
  x0Rel: number;
  x1Rel: number;
}

interface Tracked {
  id: string;
  /** The allow-list rule of the window's app (decided at admission, re-checked with every description). */
  rule: TabStripAppRule;
  info: WindowInfo;
  infoAt: number;
  vx: number;
  vy: number;
  interested: boolean;
  /** Of interest at the slow rate (a far candidate). */
  slow: boolean;
  lastInterestAt: number;
  strip: RelativeStrip | null;
  stripAt: number;
  lastRequestAt: number;
  lastReadMs: number | null;
  inFlight: boolean;
  /** An event or a resize asked for a fresh read. */
  dirty: boolean;
  selectedHint: boolean;
  retryAt: number;
  errorStreak: number;
  lastError: string | null;
  snapshot: Snapshot | null;
  pendingChange: { change: Change; dueAt: number } | null;
  lastEmitAt: number;
  segCache: { key: string; seg: TabStripSegment } | null;
  /** Last surface reported for this window (reused while unchanged, so identities stay stable). */
  surface: LedgeSurface | null;
  /** T6: host time of the read failure since which `strip` is the retained last good one (null: fresh). */
  retainedSince: number | null;
}

export type TabStripDebug = {
  status: SurfaceStatus['tabStrips'];
  reason: string | null;
  enabled: boolean;
  started: boolean;
  helper: {
    running: boolean;
    ready: boolean;
    pid: number | null;
    dpiMode: string | null;
    spawns: number;
    recentFailures: number;
    /** Helper replacements after a stalled browser window inside the stallRestart window. */
    stallRestarts: number;
    lastFailure: string | null;
    nextStartInMs: number | null;
    /** While unavailable after repeated failures: when the next start is tried. */
    retryInMs: number | null;
    lines: number;
    malformed: number;
    oversized: number;
    timeouts: number;
    orphanResponses: number;
    stderrBytes: number;
  };
  windows: number;
  interested: number;
  /** Of those, polled at the slow rate. */
  interestedSlow: number;
  withStrip: number;
  /** Windows quarantined after their browser stalled the helper. */
  stalled: number;
  watched: number;
  /** Strip requests sent / answered (ok or error) / failed (error answer or transport). */
  reads: number;
  readsDone: number;
  readErrors: number;
  lastReadMs: number | null;
  eventsIn: { selected: number; structure: number };
  eventsOut: number;
  eventsDropped: number;
  /** v1.2 counts-only request log: strip and watch requests per allow-listed app (never ids). */
  requestsByApp: Record<TabStripAppSlug, number>;
  /** v1.2 Explorer kill switch: 'on', 'session' (tripped this session) or 'version' (until the next app version). */
  explorer: { rule: 'shipped' | 'enabled' | 'off'; killSwitch: 'on' | 'session' | 'version'; strikes: number };
  /** T6: strips currently retained after a failed read. */
  retained: number;
};

/** Counts and codes for the surface diagnostics (ProviderDiagnostics.tabStrips): no ids, titles or names. */
export interface TabStripDiagnostics {
  state: SurfaceStatus['tabStrips'];
  helperRunning: boolean;
  /** Windows currently of interest (being measured). */
  interest: number;
  /** Windows with a usable strip right now. */
  strips: number;
  /** Strip requests sent / failed (error answer, timeout or transport). */
  reads: number;
  errors: number;
  /** Host clock (ms) of the last successful read (0 = never). */
  lastReadAt: number;
  /**
   * Why the window last found without a usable strip has none (cleared once it has one):
   * 'maximized', 'noHeadroom', 'vertical', 'noTabs', 'tooNarrow', 'timeout', 'hung', 'excluded',
   * or the helper's error code in camelCase (e.g. 'noStrip', 'rejected', 'gone').
   */
  lastRejection: string | null;
  /** Host clock (ms) when lastRejection was recorded (0 = none). */
  lastRejectionAt: number;
  /** v1.2: usable strips by reader kind (ProviderDiagnostics.tabStrips.byKind); absent from older fakes. */
  byKind?: Record<TabStripKind, number>;
}

/** What the real service offers beyond the TabStripService contract (fakes may not). */
export interface TabStripServiceExtras {
  /** As the contract's; `slow` (a subset of windowIds) are polled every slowPollIntervalMs. */
  setInterest(windowIds: readonly string[], now: number, slow?: readonly string[]): void;
  diagnostics(): TabStripDiagnostics;
  /**
   * v1.2 Explorer kill switch (ADR 0003 §7.2): the shell broadcast TaskbarCreated (Explorer
   * restarted). Within explorerKillWindowMs of an Explorer request it turns Explorer off.
   */
  noteTaskbarCreated?(now: number): void;
  /** v1.2: this process's tab strips are read right now (allow-list, opt-outs, the kill switch, test mode). */
  readsApp?(processName: string): boolean;
  /**
   * Window `id` cannot give a usable strip for now: the helper rejected it, it stalled the helper,
   * its last read failed (inside the retry backoff), or its strip is unusable for a lasting reason
   * (vertical tabs, no tabs, no head room, too narrow). A resize, restore or helper event asks for a
   * fresh read and clears it. The surface provider gives such windows no far place.
   */
  unusable?(id: string, now: number): boolean;
}

export const hasTabStripExtras = (s: TabStripService): s is TabStripService & TabStripServiceExtras =>
  typeof (s as Partial<TabStripServiceExtras>).diagnostics === 'function';

const SEGMENT_REJECTION: Record<SegmentDisabledReason, string> = {
  maximized: 'maximized',
  vertical: 'vertical',
  'no-tabs': 'noTabs',
  'no-head-room': 'noHeadroom',
  'too-narrow': 'tooNarrow',
};

/** Segment reasons that hold until the window is resized or its tabs change (maximized windows are never asked). */
const LASTING_SEGMENT_REASONS: ReadonlySet<SegmentDisabledReason> = new Set<SegmentDisabledReason>(['vertical', 'no-tabs', 'no-head-room', 'too-narrow']);

/** A helper error slug (validated by the protocol: lower-case letters and dashes) in camelCase. */
const helperRejection = (code: string): string => code.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Helper answers that keep the last good strip for the retention period (T6): the window is still there. */
const RETAINED_ERRORS: ReadonlySet<string> = new Set(['not-found', 'unavailable', 'internal', 'kind-mismatch', 'no-strip']);

const ZERO_APP_COUNTS = (): Record<TabStripAppSlug, number> => ({ edge: 0, chrome: 0, explorer: 0, terminal: 0 });

function toGeometry(s: WireStrip): StripGeometry {
  return {
    frame: fromWireRect(s.frame),
    work: s.work ? fromWireRect(s.work) : null,
    dpi: s.dpi,
    container: s.container ? fromWireRect(s.container) : null,
    tabs: s.tabs.map((t) => ({ x: t.x, y: t.y, width: t.w, height: t.h, selected: t.selected })),
    count: s.count,
    leftButton: s.leftButton ? fromWireRect(s.leftButton) : null,
    newTab: s.newTab ? fromWireRect(s.newTab) : null,
    grab: s.grab ? fromWireRect(s.grab) : null,
    captions: s.captions ? fromWireRect(s.captions) : null,
    maximized: s.maximized,
    vertical: s.vertical,
  };
}

const tabStripEnabled = (s: Settings): boolean => !s.behavior.disabledBehaviors.includes('tabStrips');
/** Every opt-out that can switch an app off (v2 list, v1.2 extras and the implied ones). */
const disabledSetOf = (s: Settings): ReadonlySet<string> => disabledBehaviorSet(s.behavior);

const sameSpan = (a: { x0: number; x1: number } | null, b: { x0: number; x1: number } | null): boolean =>
  a === b || (a !== null && b !== null && a.x0 === b.x0 && a.x1 === b.x1);

/** Same reported surface apart from its validation time. */
const sameSurface = (a: LedgeSurface, b: LedgeSurface): boolean =>
  a.id === b.id &&
  a.y === b.y &&
  a.x0 === b.x0 &&
  a.x1 === b.x1 &&
  sameSpan(a.rest, b.rest) &&
  a.focusX === b.focusX &&
  a.vx === b.vx &&
  a.vy === b.vy &&
  a.confidence === b.confidence &&
  a.displayId === b.displayId &&
  a.phase === b.phase;

/** The contract with a typed debugInfo and the extras (still assignable to TabStripService). */
export type TabStripServiceImpl = Omit<TabStripService, 'debugInfo' | 'setInterest'> &
  TabStripServiceExtras & { debugInfo(): TabStripDebug; unusable(id: string, now: number): boolean; noteTaskbarCreated(now: number): void; readsApp(processName: string): boolean };

export function createTabStripService(deps: TabStripServiceDeps): TabStripServiceImpl {
  const o: TabStripServiceOptions = { ...DEFAULT_TAB_STRIP_OPTIONS, ...deps.options };
  const log = deps.logger.child('tabStrips');
  const now = deps.now ?? (() => performance.now());
  const budget = new RestartBudget(o.restart);
  const stallBudget = new RestartBudget(o.stallRestart);

  let started = false;
  let enabled = tabStripEnabled(deps.settings);
  let catSize = deps.settings.appearance.size;
  let disabled = disabledSetOf(deps.settings);

  // ---- v1.2 allow-list state: the Explorer kill switch and the per-app request pacing
  const health = createUiaHealth({ filePath: deps.healthFile ?? null, appVersion: deps.appVersion ?? 'dev', logger: log });
  /** 'version': off until the next app version (persisted); 'session': off until restart. */
  let explorerKill: 'on' | 'session' | 'version' = health.explorerAllowed() ? 'on' : 'version';
  if (explorerKill === 'version') log.warn('explorer tab strips are off for this app version (shell restarted twice after explorer reads)');
  let lastExplorerRequestAt = Number.NEGATIVE_INFINITY;
  /** Last request per paced app (rules with limits). */
  const lastAppRequestAt = new Map<TabStripAppSlug, number>();
  const requestsByApp = ZERO_APP_COUNTS();
  const overrides = (): TabStripRuleOverrides => (explorerKill !== 'on' ? { explorer: false } : o.enableExplorerTabs ? { explorer: true } : {});
  /** The enabled, not opted-out allow-list rule of a window's process, or null. */
  const ruleOf = (info: WindowInfo): TabStripAppRule | null => tabStripRuleFor(info.processName, disabled, overrides());
  const isCandidate = (info: WindowInfo): boolean => ruleOf(info) !== null && !info.excluded && !info.minimized && !info.fullscreen;
  /** Why a window is not a candidate, as a diagnostics code. */
  const candidateRejection = (info: WindowInfo): string =>
    info.excluded ? 'excluded' : info.fullscreen ? 'fullscreen' : info.minimized ? 'minimized' : tabStripAppRule(info.processName) !== null ? 'appOff' : 'unsupportedApp';
  /** A paced app (Explorer) may be sent a request now. */
  const paced = (rule: TabStripAppRule, at: number): boolean => {
    const lim = rule.limits;
    if (!lim) return true;
    const last = lastAppRequestAt.get(rule.slug);
    return last === undefined || at - last >= 1000 / lim.maxRequestsPerSec;
  };
  function noteRequest(rule: TabStripAppRule, at: number): void {
    requestsByApp[rule.slug]++;
    if (rule.limits) lastAppRequestAt.set(rule.slug, at);
    if (rule.slug === 'explorer') lastExplorerRequestAt = at;
  }
  /** Not installed / not Windows: cannot be fixed at run time. An injected spawner (tests) runs anywhere. */
  const permanentReason: string | null =
    deps.helperPath === null ? 'UI Automation helper not installed' : process.platform !== 'win32' && deps.spawnHelper === undefined ? 'tab strips need Windows' : null;
  let unavailableReason: string | null = permanentReason;
  let helperReady = false;
  let helperDpiMode: string | null = null;
  let nextStartAt = 0;
  let lastFailure: string | null = null;
  /** Unavailable after the restart budget ran out: one more start is tried at this time. */
  let recoverAt: number | null = null;
  /** That retry is running: its failure makes the feature unavailable again at once. */
  let probation = false;
  let lastWantedAt = 0;
  let watchedKey = '';
  let watchInFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const windows = new Map<string, Tracked>();
  /** Last list returned by surfaces(); returned again (same identity) while nothing changed. */
  let published: readonly LedgeSurface[] = [];
  const rejected = new Map<string, number>();
  /**
   * Windows whose browser stalled the helper: not queried before `until`, not watched until a read
   * is answered again. Kept apart from `windows` so a dropped and re-admitted window stays quarantined.
   */
  const stalls = new Map<string, { until: number; streak: number }>();
  const queue: SimEvent[] = [];
  const stats = { reads: 0, readsDone: 0, readErrors: 0, lastReadMs: null as number | null, lastReadAt: 0, eventsIn: { selected: 0, structure: 0 }, eventsOut: 0, eventsDropped: 0 };
  /** The window last found without a usable strip, and why (the id never leaves the service). */
  let rejection: { id: string; code: string; at: number } | null = null;

  function reject(id: string, code: string, at: number): void {
    if (rejection?.id === id && rejection.code === code) return;
    rejection = { id, code, at };
  }

  /** A usable strip (or a window no longer of interest) clears its rejection. */
  function clearRejection(id: string): void {
    if (rejection?.id === id) rejection = null;
  }

  function noteSegment(t: Tracked, seg: TabStripSegment | null, at: number): void {
    if (seg === null) return;
    if (seg.ok) clearRejection(t.id);
    else if (t.interested) reject(t.id, SEGMENT_REJECTION[seg.reason], at);
  }

  const client: UiaHelperClient | null =
    deps.helperPath === null
      ? null
      : new UiaHelperClient({
          helperPath: deps.helperPath,
          spawn: deps.spawnHelper ?? spawnUiaHelper,
          logger: log,
          now,
          requestTimeoutMs: o.requestTimeoutMs,
          quitGraceMs: o.quitGraceMs,
          maxLineBytes: o.maxLineBytes,
          onEvent: (ev) => onHelperEvent(ev),
          onExit: (exit) => onHelperExit(exit),
        });

  const active = (): boolean => started && enabled && unavailableReason === null && client !== null;
  const queryable = (t: Tracked): boolean => isCandidate(t.info) && !t.info.maximized;
  const quarantined = (id: string, at: number): boolean => {
    const s = stalls.get(id);
    return s !== undefined && at < s.until;
  };

  /** The browser of window `id` stalled (timed out in the helper, or the helper found it hung). */
  function stall(id: string, at: number): void {
    const streak = (stalls.get(id)?.streak ?? 0) + 1;
    const ms = Math.min(o.stalledWindowMaxMs, o.stalledWindowMs * 2 ** (streak - 1));
    if (stalls.size >= 64) {
      for (const [k, s] of stalls) if (s.until <= at) stalls.delete(k);
    }
    stalls.set(id, { until: at + ms, streak });
    log.info('tab strip window not responding; skipping it', { streak, retryInMs: ms });
  }

  // ------------------------------------------------------------------ windows

  function drop(t: Tracked, reason: string): void {
    if (windows.get(t.id) !== t) return;
    windows.delete(t.id);
    // Idle or evicted windows simply stopped mattering; the other reasons explain a missing strip.
    if (reason === 'idle' || reason === 'evicted') clearRejection(t.id);
    log.debug('tab strip window dropped', { reason });
  }

  /** Re-reads the window description; drops it (false) when it is gone, excluded or no longer a candidate. */
  function refreshInfo(t: Tracked, at: number): boolean {
    const info = deps.describeWindow(t.id);
    // A recycled HWND of another app, or an app switched off meanwhile, is dropped like a non-candidate.
    if (info === null || !isCandidate(info) || ruleOf(info) !== t.rule) {
      const reason = info === null ? 'gone' : info.excluded ? 'excluded' : 'not a candidate';
      if (info === null) clearRejection(t.id);
      else if (t.interested) reject(t.id, candidateRejection(info), at);
      drop(t, reason);
      return false;
    }
    // T6: a retained strip goes at once when the window is maximized or its width changed. So does one
    // in quarantine: no read will catch up, and a window found hung was not supposed to change at all.
    if ((t.retainedSince !== null || quarantined(t.id, at)) && t.strip !== null && (info.maximized || Math.abs(info.rect.width - t.strip.frameWidth) > o.retainWidthTolerancePx)) {
      dropStrip(t);
    }
    const dt = at - t.infoAt;
    if (dt > 0 && dt <= 1000) {
      t.vx = ((info.rect.x - t.info.rect.x) * 1000) / dt;
      t.vy = ((info.rect.y - t.info.rect.y) * 1000) / dt;
    } else if (dt > 1000) {
      t.vx = 0;
      t.vy = 0;
    }
    if (t.strip !== null) {
      const resized = info.rect.width !== t.strip.frameWidth || info.rect.height !== t.strip.frameHeight;
      const restored = t.info.maximized && !info.maximized;
      if (resized || restored) t.dirty = true;
    }
    t.info = info;
    t.infoAt = at;
    return true;
  }

  function admit(id: string, at: number): Tracked | null {
    const existing = windows.get(id);
    if (existing) {
      if (at - existing.infoAt >= o.describeIntervalMs && !refreshInfo(existing, at)) return null;
      return existing;
    }
    const until = rejected.get(id);
    if (until !== undefined) {
      if (at < until) return null;
      rejected.delete(id);
    }
    const info = deps.describeWindow(id);
    if (info === null) return null;
    const rule = ruleOf(info);
    if (rule === null || !isCandidate(info)) {
      reject(id, candidateRejection(info), at);
      return null;
    }
    // Explorer: at most limits.maxWindows windows measured at once (an idle one makes room).
    const maxOfApp = rule.limits?.maxWindows;
    if (maxOfApp !== undefined) {
      const same = [...windows.values()].filter((w) => w.rule === rule);
      if (same.length >= maxOfApp) {
        let victim: Tracked | null = null;
        for (const w of same) if (!w.interested && (victim === null || w.lastInterestAt < victim.lastInterestAt)) victim = w;
        if (victim === null) {
          reject(id, 'appLimit', at);
          return null;
        }
        drop(victim, 'evicted');
      }
    }
    if (windows.size >= o.maxWindows) {
      let victim: Tracked | null = null;
      for (const t of windows.values()) if (!t.interested && (victim === null || t.lastInterestAt < victim.lastInterestAt)) victim = t;
      if (victim === null) return null;
      drop(victim, 'evicted');
    }
    const t: Tracked = {
      id,
      rule,
      info,
      infoAt: at,
      vx: 0,
      vy: 0,
      interested: false,
      slow: false,
      lastInterestAt: at,
      strip: null,
      stripAt: 0,
      lastRequestAt: Number.NEGATIVE_INFINITY,
      lastReadMs: null,
      inFlight: false,
      dirty: false,
      selectedHint: false,
      retryAt: 0,
      errorStreak: 0,
      lastError: null,
      snapshot: null,
      pendingChange: null,
      lastEmitAt: Number.NEGATIVE_INFINITY,
      segCache: null,
      surface: null,
      retainedSince: null,
    };
    windows.set(id, t);
    return t;
  }

  /** Forgets the window's strip (the plain top is used again). */
  function dropStrip(t: Tracked): void {
    t.strip = null;
    t.segCache = null;
    t.snapshot = null;
    t.retainedSince = null;
  }

  function segmentFor(t: Tracked): TabStripSegment | null {
    if (t.strip === null) return null;
    const r = t.info.rect;
    const key = `${t.stripAt}|${r.x},${r.y},${r.width},${r.height}|${t.info.maximized}|${catSize}`;
    if (t.segCache?.key === key) return t.segCache.seg;
    const seg = computeTabStripSegment(placeStrip(t.strip, r, t.info.maximized), catExtentPx(catSize, t.strip.dpi));
    t.segCache = { key, seg };
    return seg;
  }

  function snapshotOf(t: Tracked): Snapshot | null {
    const strip = t.strip;
    if (strip === null) return null;
    const tabs = [...strip.tabs].sort((a, b) => a.x - b.x);
    const sel = tabs.findIndex((x) => x.selected);
    const selTab = sel >= 0 ? tabs[sel] : undefined;
    const seg = segmentFor(t);
    const fx = t.info.rect.x;
    return {
      count: strip.count,
      selectedIndex: sel >= 0 ? sel : null,
      focusRel: selTab ? selTab.x + selTab.width / 2 : null,
      ok: seg?.ok === true,
      x0Rel: seg?.ok === true ? seg.x0 - fx : 0,
      x1Rel: seg?.ok === true ? seg.x1 - fx : 0,
    };
  }

  function detectChange(t: Tracked, at: number, selectedHint: boolean): void {
    const next = snapshotOf(t);
    const prev = t.snapshot;
    t.snapshot = next;
    if (prev === null || next === null) return;
    let change: Change | null = null;
    if (next.count > prev.count) change = 'added';
    else if (next.count < prev.count) change = 'removed';
    else if (next.selectedIndex !== prev.selectedIndex) change = 'selected';
    else if (selectedHint && prev.focusRel !== null && next.focusRel !== null && Math.abs(next.focusRel - prev.focusRel) > 2) change = 'selected';
    else if (next.ok !== prev.ok || Math.abs(next.x0Rel - prev.x0Rel) > 2 || Math.abs(next.x1Rel - prev.x1Rel) > 2) change = 'geometry';
    if (change !== null) queueChange(t, change, at);
  }

  function queueChange(t: Tracked, change: Change, at: number): void {
    const p = t.pendingChange;
    if (p !== null) {
      if (CHANGE_PRIORITY[change] >= CHANGE_PRIORITY[p.change]) p.change = change;
      return;
    }
    t.pendingChange = { change, dueAt: Math.max(at, t.lastEmitAt + o.eventDebounceMs) };
  }

  function flushChanges(at: number): void {
    for (const t of windows.values()) {
      const p = t.pendingChange;
      if (p === null || at < p.dueAt) continue;
      t.pendingChange = null;
      t.lastEmitAt = at;
      const seg = segmentFor(t);
      if (queue.length >= o.eventQueueCapacity) {
        queue.shift();
        stats.eventsDropped++;
      }
      queue.push({ type: 'tabs.changed', surfaceId: tabStripSurfaceId(t.id), ownerId: t.id, change: p.change, focusX: seg?.ok === true ? seg.focusX : null });
      stats.eventsOut++;
    }
  }

  // ------------------------------------------------------------------ helper lifecycle

  function markUnavailable(reason: string): void {
    unavailableReason = reason;
    log.warn('tab strips unavailable', { reason });
    windows.clear();
    watchedKey = '';
    helperReady = false;
    client?.kill();
  }

  function fail(reason: string, at: number): void {
    lastFailure = reason;
    if (probation) {
      // The one start tried after the budget ran out failed as well.
      probation = false;
      recoverAt = at + o.restart.windowMs;
      markUnavailable(`helper still failing after a retry (last: ${reason})`);
      return;
    }
    const next = budget.recordFailure(at);
    if (client?.running) client.kill();
    helperReady = false;
    watchedKey = '';
    if (next === null) {
      recoverAt = at + o.restart.windowMs;
      markUnavailable(`helper failed ${budget.recentFailures} times in ${Math.round(o.restart.windowMs / 60_000)} min (last: ${reason})`);
      return;
    }
    nextStartAt = next;
    log.warn('uia helper failed; restarting with backoff', { reason, delayMs: Math.round(next - at) });
  }

  /**
   * Requests timed out. The helper answers one at a time, so the first of them (oldest) is the one
   * it is stuck in; the others only queued behind it. Stuck in a strip or watch request means stuck
   * in a browser's UI Automation provider (that browser's UI thread stopped: Not Responding,
   * suspended, busy): those windows are quarantined and the helper is replaced without them,
   * outside the restart budget. A ping touches no browser: then the helper itself hung.
   */
  function onTimeouts(timedOut: readonly HelperRequest[], at: number): void {
    const first = timedOut[0];
    let blamed: string[] = [];
    if (first?.op === 'strip') blamed = [first.hwnd];
    else if (first?.op === 'watch') {
      // Subscribing and unsubscribing call into the browsers; windows that stay watched are not touched.
      const before = new Set(watchedKey === '' ? [] : watchedKey.split(','));
      const after = new Set(first.hwnds);
      blamed = [...first.hwnds.filter((h) => !before.has(h)), ...[...before].filter((h) => !after.has(h))];
    }
    blamed = blamed.filter((id) => windows.has(id));
    if (blamed.length === 0) {
      fail('request timed out (helper hung)', at);
      return;
    }
    for (const id of blamed) {
      stall(id, at);
      reject(id, 'timeout', at);
      // T6: unread for the whole quarantine although its thread may recover at once, so the last good
      // strip has the same limits as after a failed read.
      const t = windows.get(id);
      if (t && t.strip !== null && t.retainedSince === null) {
        t.retainedSince = at;
        t.surface = null;
      }
    }
    const next = stallBudget.recordFailure(at);
    if (next === null) {
      fail('request timed out (browser windows keep stalling the helper)', at);
      return;
    }
    lastFailure = 'browser window not responding';
    client?.kill();
    helperReady = false;
    watchedKey = '';
    nextStartAt = next;
    log.warn('uia helper stuck in a browser that stopped responding; replacing it', { windows: blamed.length, delayMs: Math.round(next - at) });
  }

  /** After the restart budget ran out: one more start once its window passed without a failure. */
  function maybeRecover(at: number): void {
    if (recoverAt === null || at < recoverAt || !started || !enabled) return;
    recoverAt = null;
    unavailableReason = null;
    nextStartAt = 0;
    probation = true;
    log.info('tab strips: trying the helper again');
  }

  function onHelperExit(exit: HelperExit): void {
    helperReady = false;
    watchedKey = '';
    watchInFlight = false;
    for (const t of windows.values()) t.inFlight = false;
    if (exit.expected) {
      log.info('uia helper stopped', { uptimeMs: Math.round(exit.uptimeMs) });
      return;
    }
    if (!active()) return;
    const reason = exit.error !== null ? `could not run (${exit.error})` : `exited (code ${exit.code ?? 'none'}${exit.signal ? `, ${exit.signal}` : ''})`;
    fail(reason, now());
  }

  function startHelper(at: number): void {
    if (client === null) return;
    helperReady = false;
    helperDpiMode = null;
    watchedKey = '';
    watchInFlight = false;
    lastWantedAt = at;
    if (!client.start()) return;
    log.info('uia helper started', { pid: client.pid });
    client.request({ op: 'ping' }, at).then(
      (r) => {
        if (!r.ok || r.pong !== true) {
          fail(`bad ping response (${r.ok ? 'no pong' : r.error})`, now());
          return;
        }
        if (r.version !== UIA_PROTOCOL_VERSION) {
          markUnavailable(`helper protocol ${r.version ?? 'unknown'} != ${UIA_PROTOCOL_VERSION}`);
          return;
        }
        helperReady = true;
        probation = false;
        helperDpiMode = r.dpi ?? null;
        if (r.dpi !== undefined && r.dpi !== 'permonitorv2' && r.dpi !== 'preset') log.warn('uia helper is not per-monitor DPI aware', { dpi: r.dpi });
        pump(now());
      },
      (e: unknown) => onTransportError(e),
    );
  }

  function onTransportError(e: unknown): void {
    // Timeouts are handled in pump (checkTimeouts) and exits in onHelperExit.
    if (!(e instanceof HelperTransportError)) log.error('uia helper request failed', { error: String(e) });
  }

  function onHelperEvent(ev: HelperEvent): void {
    stats.eventsIn[ev.event]++;
    const t = windows.get(ev.hwnd);
    if (!t) return;
    t.dirty = true;
    if (ev.event === 'selected') t.selectedHint = true;
    pump(now());
  }

  // ------------------------------------------------------------------ reads

  function read(t: Tracked, at: number): void {
    if (client === null) return;
    // The exclusion verdict is re-checked right before every query.
    if (!refreshInfo(t, at) || !queryable(t)) return;
    t.inFlight = true;
    t.lastRequestAt = at;
    t.dirty = false;
    const hint = t.selectedHint;
    t.selectedHint = false;
    stats.reads++;
    noteRequest(t.rule, at);
    client.request({ op: 'strip', hwnd: t.id }, at, t.rule.limits?.timeoutMs).then(
      (r) => onStrip(t, r, hint),
      (e: unknown) => {
        t.inFlight = false;
        stats.readErrors++;
        onTransportError(e);
      },
    );
  }

  function onStrip(t: Tracked, r: HelperResponse, hint: boolean): void {
    t.inFlight = false;
    stats.readsDone++;
    if (windows.get(t.id) !== t || !active()) return;
    const at = now();
    // Kind cross-check: a strip from another reader than the app's rule is never used.
    const mismatch = r.ok && r.strip !== undefined && stripKind(r.strip) !== t.rule.kind;
    if (!r.ok || r.strip === undefined || mismatch) {
      stats.readErrors++;
      const code = mismatch ? 'kind-mismatch' : r.ok ? 'no-strip' : r.error;
      if (mismatch) log.warn('tab strip of an unexpected reader kind dropped', { expected: t.rule.kind });
      t.lastError = code;
      if (code === 'gone') clearRejection(t.id);
      else reject(t.id, helperRejection(code), at);
      if (code === 'hung') {
        // The helper found the browser not responding before calling into it. Its strip cannot
        // have moved (a hung window does not move or repaint), so it stays listed while it ages.
        stall(t.id, at);
        return;
      }
      stalls.delete(t.id);
      if (code === 'gone') {
        drop(t, 'gone');
        return;
      }
      if (code === 'rejected') {
        rejected.set(t.id, at + o.rejectedWindowMs);
        drop(t, 'rejected by helper');
        return;
      }
      const hadStrip = t.strip !== null;
      // T6: the last good strip stays listed for retainStripMs (a kind mismatch never keeps one).
      if (hadStrip && t.retainedSince === null && RETAINED_ERRORS.has(code) && !mismatch) {
        t.retainedSince = at;
        t.surface = null;
      } else if (t.retainedSince === null || mismatch) {
        dropStrip(t);
      }
      t.errorStreak++;
      t.retryAt = at + Math.min(o.windowRetryMaxMs, o.windowRetryMs * 2 ** (t.errorStreak - 1));
      if (hadStrip) log.debug('tab strip lost', { error: code, retained: t.retainedSince !== null });
      return;
    }
    const geo = toGeometry(r.strip);
    stalls.delete(t.id);
    t.strip = toRelativeStrip(geo);
    t.stripAt = at;
    t.retainedSince = null;
    t.segCache = null;
    t.errorStreak = 0;
    t.lastError = null;
    t.lastReadMs = r.strip.ms;
    stats.lastReadMs = r.strip.ms;
    stats.lastReadAt = at;
    // The helper's frame was read after our description: adopt it.
    t.info = { ...t.info, rect: geo.frame, maximized: geo.maximized };
    t.infoAt = at;
    detectChange(t, at, hint);
    noteSegment(t, segmentFor(t), at);
    pump(at);
  }

  function syncWatch(at: number): void {
    if (client === null || watchInFlight) return;
    // A stalled window is subscribed again only after a read was answered (subscribing calls into it).
    const wanted = [...windows.values()]
      .filter((t) => t.strip !== null && queryable(t) && !stalls.has(t.id))
      .map((t) => t.id)
      .sort()
      .slice(0, 16);
    // Subscribing calls into each new window's browser: one new window per request, so a request
    // stuck in a browser that stopped responding names that window (onTimeouts).
    const current = new Set(watchedKey === '' ? [] : watchedKey.split(','));
    const added = wanted.find((id) => !current.has(id));
    const ids = wanted.filter((id) => current.has(id) || id === added);
    const key = ids.join(',');
    if (key === watchedKey) return;
    // Subscribing or unsubscribing calls into those windows' apps: paced apps (Explorer) count it as
    // a request and wait for their turn. A window that is gone from `windows` is not paced (nothing to call).
    const touched = new Set<TabStripAppRule>();
    for (const id of [...(added !== undefined ? [added] : []), ...[...current].filter((id) => !ids.includes(id))]) {
      const rule = windows.get(id)?.rule;
      if (rule) touched.add(rule);
    }
    for (const rule of touched) if (!paced(rule, at)) return;
    for (const rule of touched) noteRequest(rule, at);
    const timeoutMs = Math.max(0, ...[...touched].map((r) => r.limits?.timeoutMs ?? 0));
    watchInFlight = true;
    client.request({ op: 'watch', hwnds: ids }, at, timeoutMs > 0 ? timeoutMs : undefined).then(
      (r) => {
        watchInFlight = false;
        // Remember the set even on failure so a broken subscription does not retry in a loop.
        watchedKey = key;
        if (!r.ok) log.debug('uia watch failed', { error: r.error });
        else if ((r.failed?.length ?? 0) > 0) log.debug('uia watch incomplete', { failed: r.failed?.length ?? 0 });
        // Subscribe the next new window, if any.
        if (key !== wanted.join(',')) pump(now());
      },
      (e: unknown) => {
        watchInFlight = false;
        onTransportError(e);
      },
    );
  }

  function scheduleReads(at: number): void {
    let inFlight = 0;
    for (const t of windows.values()) if (t.inFlight) inFlight++;
    // Windows of interest first, the near ones (normal rate) before the far ones (slow rate); apps
    // read last (Explorer) after all others in each cycle.
    const rank = (t: Tracked): number => (t.interested ? (t.slow ? 1 : 2) : 0);
    const lastOf = (t: Tracked): number => (t.rule.limits?.last === true ? 1 : 0);
    const order = [...windows.values()].sort((a, b) => lastOf(a) - lastOf(b) || rank(b) - rank(a) || b.lastInterestAt - a.lastInterestAt);
    for (const t of order) {
      if (inFlight >= o.maxInFlight) return;
      // A maximized window is never asked (its strip has no room above it).
      if (t.interested && t.info.maximized) reject(t.id, 'maximized', at);
      if (t.inFlight || !queryable(t) || at < t.retryAt || quarantined(t.id, at)) continue;
      // Paced apps: one request per period for all their windows; never two in flight.
      if (t.rule.limits && (!paced(t.rule, at) || [...windows.values()].some((w) => w.inFlight && w.rule === t.rule))) continue;
      const period = t.slow ? o.slowPollIntervalMs : o.pollIntervalMs;
      const due = t.strip === null || (t.dirty ? at - t.lastRequestAt >= o.refreshGapMs : t.interested && at - t.stripAt >= period);
      if (!due) continue;
      read(t, at);
      if (t.inFlight) inFlight++;
    }
  }

  function pump(at: number): void {
    maybeRecover(at);
    if (!active() || client === null) return;
    if (client.running) {
      const timedOut: HelperRequest[] = [];
      if (client.checkTimeouts(at, timedOut) > 0) onTimeouts(timedOut, at);
    }
    if (!active()) return;
    for (const t of [...windows.values()]) {
      if (!t.interested && at - t.lastInterestAt >= o.idleShutdownMs) drop(t, 'idle');
      else if (at - t.infoAt >= o.describeIntervalMs) refreshInfo(t, at);
    }
    // A quarantined window alone does not keep (or bring back) a helper: it would only idle.
    let wanted = false;
    for (const t of windows.values()) {
      if (t.interested && queryable(t) && !quarantined(t.id, at)) {
        wanted = true;
        break;
      }
    }
    if (wanted) lastWantedAt = at;
    if (!client.running) {
      if (wanted && at >= nextStartAt) startHelper(at);
    } else if (!client.stopping && at - lastWantedAt >= o.idleShutdownMs) {
      log.info('tab strips idle; stopping the helper');
      helperReady = false;
      client.quit();
    }
    if (client.running && !client.stopping && helperReady) {
      syncWatch(at);
      scheduleReads(at);
    }
    flushChanges(at);
  }

  function shutdown(): void {
    windows.clear();
    rejected.clear();
    stalls.clear();
    rejection = null;
    queue.length = 0;
    watchedKey = '';
    helperReady = false;
    client?.quit();
  }

  function publish(list: LedgeSurface[]): readonly LedgeSurface[] {
    if (list.length === published.length && list.every((s, i) => s === published[i])) return published;
    published = list;
    return published;
  }

  function armTimer(): void {
    if (timer !== null || o.autoPumpMs <= 0) return;
    timer = setInterval(() => pump(now()), o.autoPumpMs);
    timer.unref?.();
  }

  function disarmTimer(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  // ------------------------------------------------------------------ public API

  const service: TabStripServiceImpl = {
    get status(): SurfaceStatus['tabStrips'] {
      if (!started || !enabled) return 'off';
      if (unavailableReason !== null) return 'unavailable';
      return client !== null && client.running && !client.stopping ? 'active' : 'idle';
    },

    get statusReason(): string | null {
      return started && enabled ? unavailableReason : null;
    },

    start(): void {
      if (started) return;
      started = true;
      if (enabled) armTimer();
      if (permanentReason !== null && enabled) log.info('tab strips unavailable', { reason: permanentReason });
    },

    stop(): void {
      if (!started) return;
      started = false;
      disarmTimer();
      shutdown();
    },

    updateSettings(settings: Settings): void {
      catSize = settings.appearance.size;
      // Per-app opt-outs (explorerTabs, terminalTabs): their windows are dropped at the next description.
      disabled = disabledSetOf(settings);
      const next = tabStripEnabled(settings);
      if (next === enabled) return;
      enabled = next;
      if (!enabled) {
        disarmTimer();
        shutdown();
        return;
      }
      // Turning the feature back on is an explicit retry after repeated helper failures.
      if (unavailableReason !== null && permanentReason === null) {
        budget.reset();
        stallBudget.reset();
        unavailableReason = null;
        recoverAt = null;
        probation = false;
        nextStartAt = 0;
      }
      if (started) armTimer();
    },

    setInterest(windowIds: readonly string[], at: number, slow: readonly string[] = []): void {
      maybeRecover(at);
      if (!active()) return;
      const admitted = new Set<string>();
      const scanLimit = o.maxInterest * 4;
      for (let i = 0; i < windowIds.length && i < scanLimit && admitted.size < o.maxInterest; i++) {
        const id = windowIds[i];
        if (id === undefined || admitted.has(id) || !HWND_PATTERN.test(id)) continue;
        const t = admit(id, at);
        if (t === null) continue;
        admitted.add(id);
        t.interested = true;
        t.slow = slow.includes(id);
        t.lastInterestAt = at;
      }
      for (const t of windows.values()) {
        if (admitted.has(t.id)) continue;
        t.interested = false;
        t.slow = false;
      }
      pump(at);
    },

    surfaces(): readonly LedgeSurface[] {
      if (!active()) return publish([]);
      const at = now();
      const out: LedgeSurface[] = [];
      for (const t of [...windows.values()]) {
        if (t.strip === null) continue;
        // Live descriptions only for the windows the cat is on or near; far (slow) ones are only
        // possible destinations, and the provider shifts their strips with the window meanwhile.
        const maxAge = t.interested && !t.slow ? o.liveDescribeMs : o.describeIntervalMs;
        if (at - t.infoAt >= maxAge && !refreshInfo(t, at)) continue;
        if (!queryable(t)) continue;
        const seg = segmentFor(t);
        // Moves and resizes between reads re-place the strip (e.g. no head room any more).
        noteSegment(t, seg, at);
        if (seg === null || !seg.ok) continue;
        const sizeMatches = t.strip.frameWidth === t.info.rect.width && t.strip.frameHeight === t.info.rect.height;
        const age = at - t.stripAt;
        // Fresh for two periods of the rate the window is read at.
        const period = t.slow ? o.slowPollIntervalMs : o.pollIntervalMs;
        let confidence = !sizeMatches ? 0.5 : age <= 2 * period ? 1 : age <= 30_000 ? 0.85 : 0.7;
        if (t.retainedSince !== null) {
          // T6: the last good strip after a failed read, for retainStripMs at most (then the top again).
          const held = at - t.retainedSince;
          if (held > o.retainStripMs) {
            dropStrip(t);
            continue;
          }
          const k = Math.min(1, Math.max(0, held / o.retainStripMs));
          // In steps of 0.05, so the listed surface changes a few times, not on every call.
          confidence = Math.round((RETAINED_CONFIDENCE_START + (RETAINED_CONFIDENCE_END - RETAINED_CONFIDENCE_START) * k) * 20) / 20;
        }
        const next: LedgeSurface = {
          id: tabStripSurfaceId(t.id),
          kind: 'tabStrip',
          ownerId: t.id,
          displayId: deps.displayAt?.({ x: (seg.x0 + seg.x1) / 2, y: seg.y - 1 }) ?? null,
          phase: 'stable',
          vx: t.vx,
          vy: t.vy,
          confidence,
          // Time the reported geometry was measured (window rect + strip read); unchanged
          // geometry keeps its object and timestamp (the surface provider keys its shift on it).
          validatedAt: Math.max(t.infoAt, t.stripAt),
          excluded: false,
          orientation: 'ledge',
          y: seg.y,
          x0: seg.x0,
          x1: seg.x1,
          rest: seg.rest,
          focusX: seg.focusX,
        };
        const prev = t.surface;
        const s = prev !== null && sameSurface(prev, next) ? prev : next;
        t.surface = s;
        out.push(s);
      }
      return publish(out);
    },

    drainEvents(): SimEvent[] {
      if (active()) flushChanges(now());
      return queue.splice(0, queue.length);
    },

    debugInfo() {
      const at = now();
      let interested = 0;
      let interestedSlow = 0;
      let withStrip = 0;
      for (const t of windows.values()) {
        if (t.interested) interested++;
        if (t.interested && t.slow) interestedSlow++;
        if (t.strip !== null) withStrip++;
      }
      const cs = client?.stats;
      let stalled = 0;
      for (const id of stalls.keys()) if (quarantined(id, at)) stalled++;
      return {
        status: service.status,
        reason: service.statusReason,
        enabled,
        started,
        helper: {
          running: client?.running ?? false,
          ready: helperReady,
          pid: client?.pid ?? null,
          dpiMode: helperDpiMode,
          spawns: cs?.spawns ?? 0,
          recentFailures: budget.recentFailures,
          stallRestarts: stallBudget.recentFailures,
          lastFailure,
          nextStartInMs: client !== null && !client.running && nextStartAt > at ? Math.round(nextStartAt - at) : null,
          retryInMs: recoverAt !== null && unavailableReason !== null ? Math.max(0, Math.round(recoverAt - at)) : null,
          lines: cs?.lines ?? 0,
          malformed: cs?.malformed ?? 0,
          oversized: cs?.oversized ?? 0,
          timeouts: cs?.timeouts ?? 0,
          orphanResponses: cs?.orphanResponses ?? 0,
          stderrBytes: cs?.stderrBytes ?? 0,
        },
        windows: windows.size,
        interested,
        interestedSlow,
        withStrip,
        stalled,
        watched: watchedKey === '' ? 0 : watchedKey.split(',').length,
        reads: stats.reads,
        readsDone: stats.readsDone,
        readErrors: stats.readErrors,
        lastReadMs: stats.lastReadMs,
        eventsIn: { ...stats.eventsIn },
        eventsOut: stats.eventsOut,
        eventsDropped: stats.eventsDropped,
        requestsByApp: { ...requestsByApp },
        explorer: {
          rule: explorerKill !== 'on' ? 'off' : o.enableExplorerTabs ? 'enabled' : 'shipped',
          killSwitch: explorerKill,
          strikes: health.strikes(),
        },
        retained: [...windows.values()].filter((t) => t.retainedSince !== null && t.strip !== null).length,
      };
    },

    diagnostics(): TabStripDiagnostics {
      let interested = 0;
      let usable = 0;
      const byKind: Record<TabStripKind, number> = { chromium: 0, tabview: 0 };
      for (const t of windows.values()) {
        if (t.interested) interested++;
        if (t.strip !== null && queryable(t) && segmentFor(t)?.ok === true) {
          usable++;
          byKind[t.rule.kind]++;
        }
      }
      const on = active();
      return {
        state: service.status,
        helperRunning: client?.running ?? false,
        interest: on ? interested : 0,
        strips: on ? usable : 0,
        reads: stats.reads,
        errors: stats.readErrors,
        lastReadAt: stats.lastReadAt,
        lastRejection: rejection?.code ?? null,
        lastRejectionAt: rejection?.at ?? 0,
        byKind: on ? byKind : { chromium: 0, tabview: 0 },
      };
    },

    readsApp(processName: string): boolean {
      return enabled && tabStripRuleFor(processName, disabled, overrides()) !== null;
    },

    noteTaskbarCreated(at: number): void {
      // The shell restarted. Only when we spoke to Explorer recently can our reads be the cause.
      if (explorerKill !== 'on' || !(at - lastExplorerRequestAt <= o.explorerKillWindowMs)) return;
      const strike = health.recordExplorerStrike();
      explorerKill = strike.disabledForVersion ? 'version' : 'session';
      log.warn('explorer restarted soon after an explorer tab-strip read; explorer tab strips are off', {
        until: explorerKill === 'version' ? 'next app version' : 'restart',
        strikes: strike.strikes,
      });
      for (const t of [...windows.values()]) if (t.rule.slug === 'explorer') drop(t, 'kill switch');
    },

    unusable(id: string, at: number): boolean {
      if (!active()) return false;
      const until = rejected.get(id);
      if (until !== undefined && at < until) return true;
      if (quarantined(id, at)) return true;
      const t = windows.get(id);
      // Unknown (never measured, or dropped after idling): worth a read.
      if (t === undefined) return false;
      // Resized, restored or announced by the helper: worth a fresh read.
      if (t.dirty) return false;
      if (t.errorStreak > 0 && at < t.retryAt) return true;
      const seg = segmentFor(t);
      return seg !== null && !seg.ok && LASTING_SEGMENT_REASONS.has(seg.reason);
    },

    async dispose(): Promise<void> {
      service.stop();
      if (client === null) return;
      if (!(await client.waitForExit(o.quitGraceMs + 500))) {
        client.kill();
        await client.waitForExit(1000);
      }
    },
  };
  return service;
}
