import type { BehaviorProfileSnapshot } from '../../../shared/behaviorProfile';
import type { AppStatus, LoginItemStatus, ResourceSample, SettingsAction, SettingsApi, SettingsViewState } from '../../../shared/ipc';
import { CAPABILITY_IDS, type PlatformReport, type RuntimeCapability } from '../../../shared/platform';
import type { SurfaceDiagnostics } from '../../../shared/surfaceDiagnostics';
import { huntEntries, moodEntries, physicsEntries, reactionSummary, stayEntries, summaryEntries, timeRows } from '../behaviorView';
import type { PageContext, PageView } from '../context';
import { bullets, button, group, keyValues, page, row, runAction, segmentedRow, setNote, toggleRow, toggleSwitch } from '../controls';
import { h, icon, svg, uid } from '../dom';
import { behaviorStateLabel, formatCount, formatDuration, formatElapsed, formatMegabytes, formatPercentValue, formatRelativeTime, formatSampleAge } from '../format';
import { livePoll, pagePoll, type LivePoll } from '../livePoll';
import { pauseModel } from '../privacyView';
import { niceCeil, sparkline } from '../sparkline';
import { errorText, type Timers } from '../store';
import { S } from '../strings';
import { catEntries, coordinateEntries, countRows, errorItems, seenEntries, tabStripEntries } from '../surfacesView';

const D = S.diagnostics;
const V = D.surfaces;
const BV = D.behavior;
const PV = D.platform;
/** The Surfaces section re-reads main at most this often, only while the page is shown. */
export const SURFACES_REFRESH_MS = 1000;
/** The Behaviour section (v1.2) changes slowly: re-read every few seconds while the page is shown. */
export const BEHAVIOR_REFRESH_MS = 3000;
const SPARK_W = 240;
const SPARK_H = 48;
const TABLE_ROWS = 6;

function spark(label: string, samples: readonly ResourceSample[], pick: (s: ResourceSample) => number, fmt: (v: number) => string, scaleMin: number): HTMLElement {
  const values = samples.map(pick);
  const latest = values[values.length - 1];
  const peak = values.length > 0 ? Math.max(...values) : undefined;
  const max = niceCeil(peak ?? 1, scaleMin);
  const geo = sparkline(values, SPARK_W, SPARK_H, { min: 0, max });
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = first && last ? formatDuration((last.at - first.at) / 1000) : formatDuration(0);
  const titleId = uid('spark');
  const chart = svg('svg', { class: 'spark', viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, role: 'img', 'aria-labelledby': titleId }, [
    svg('title', { id: titleId, text: D.sparkCaption(label, values.length, span) }),
    svg('line', { class: 'spark-grid', x1: 0, x2: SPARK_W, y1: SPARK_H - 0.5, y2: SPARK_H - 0.5 }),
    geo.area ? svg('path', { class: 'spark-area', d: geo.area }) : null,
    geo.line ? svg('path', { class: 'spark-line', d: geo.line, 'vector-effect': 'non-scaling-stroke' }) : null,
  ]);
  // Native tooltips per sample: wide invisible hit columns over each point.
  const colW = values.length > 1 ? SPARK_W / (values.length - 1) : SPARK_W;
  geo.points.slice(0, values.length).forEach((p, i) => {
    const s = samples[i];
    if (!s) return;
    chart.append(
      svg('rect', { class: 'spark-hit', x: Math.max(0, p.x - colW / 2), y: 0, width: colW, height: SPARK_H }, [
        svg('title', { text: `${fmt(pick(s))} · ${formatSampleAge(s.at, last?.at ?? s.at)}` }),
      ]),
    );
  });
  const lastPoint = geo.points[values.length > 1 ? values.length - 1 : 1];
  if (lastPoint && values.length > 0) chart.append(svg('circle', { class: 'spark-dot', cx: lastPoint.x, cy: lastPoint.y, r: 3 }));
  return h('figure', { class: 'spark-card' }, [
    h('figcaption', { class: 'spark-head' }, [
      h('span', { class: 'spark-label', text: label }),
      h('span', { class: 'spark-value', text: latest === undefined ? S.format.missing : fmt(latest) }),
    ]),
    values.length === 0 ? h('p', { class: 'muted', text: D.noSamples }) : chart,
    h('div', { class: 'spark-foot' }, [h('span', { text: S.format.labelled(D.peak, peak === undefined ? S.format.missing : fmt(peak)) }), h('span', { text: S.format.range(fmt(0), fmt(max)) })]),
  ]);
}

function sampleTable(samples: readonly ResourceSample[]): HTMLElement | null {
  if (samples.length === 0) return null;
  const last = samples[samples.length - 1];
  const rows = samples.slice(-TABLE_ROWS).reverse();
  return h('table', { class: 'table' }, [
    h('caption', { text: D.tableTitle }),
    h('thead', {}, [h('tr', {}, [h('th', { scope: 'col', text: D.tableWhen }), h('th', { scope: 'col', text: D.cpu }), h('th', { scope: 'col', text: D.memory })])]),
    h(
      'tbody',
      {},
      rows.map((s) =>
        h('tr', {}, [
          h('td', { text: formatSampleAge(s.at, last?.at ?? s.at) }),
          h('td', { class: 'num', text: formatPercentValue(s.cpuPercent) }),
          h('td', { class: 'num', text: formatMegabytes(s.workingSetMB) }),
        ]),
      ),
    ),
  ]);
}

/** One-word "Start with Windows" state for the status list. */
export function loginItemLabel(s: LoginItemStatus): string {
  if (s.active) return D.active;
  if (!s.writable) return D.loginNotAvailable;
  if (s.disabledBy === 'windows') return D.loginWindowsDisabled;
  return s.enabled ? D.inactive : D.loginOff;
}

/**
 * The login row's name in the status list (1.4.0): "Start with Windows" on Windows (and without a
 * platform report, as before), "Open at login" on macOS, "Start when you sign in" elsewhere; the
 * same terms as the General page's launch row.
 */
export function loginItemRowLabel(platform: AppStatus['platform']): string {
  if (!platform || platform.id === 'win32') return D.launchAtLogin;
  return platform.id === 'darwin' ? D.launchAtLoginMac : D.launchAtLoginElsewhere;
}

export function statusEntries(view: SettingsViewState, now: number): Array<readonly [string, string]> {
  const { status, settings } = view;
  const p = status.perception;
  const pause = pauseModel(view);
  let perception: string = D.modes[p.mode];
  if (pause.suspended) {
    // Main's blocked reason is the generic "paused" text here; the suspension reason replaces it.
    perception = S.format.parenthetical(perception, D.perceptionSuspended[pause.suspended]);
  } else {
    if (pause.userPaused) perception = S.format.parenthetical(perception, D.perceptionPaused);
    if (p.blockedReason) perception = S.format.list(perception, p.blockedReason);
  }
  const entries: Array<readonly [string, string]> = [
    [D.catState, behaviorStateLabel(status.catState)],
    [D.windowAwareness, D.awareness[status.windowAwareness]],
    [D.displays, formatCount(status.displayCount)],
    [D.perception, perception],
    [D.capturesThisHour, formatCount(p.capturesThisHour)],
    [D.lastCapture, p.lastCaptureAt === null ? S.common.never : formatRelativeTime(p.lastCaptureAt, now)],
  ];
  if (p.lastError) entries.push([D.lastError, p.lastError]);
  entries.push(
    [D.shortcut, !settings.general.shortcutsEnabled ? D.shortcutsOff : status.shortcutRegistered ? D.registered : D.notRegistered],
    [loginItemRowLabel(status.platform), loginItemLabel(status.loginItem)],
    [D.uptime, formatElapsed(status.startedAt, now)],
  );
  return entries;
}

export interface PlatformView {
  /** This platform's label; null when main sent no platform report. */
  label: string | null;
  /** Each unavailable capability (name, main's reason), in the capability table's order. */
  unavailable: Array<readonly [string, string]>;
}

/** The Platform section (GizeVerse, ADR 0004 §2.2): this platform and what is unavailable on it. */
export function platformView(report: PlatformReport | undefined): PlatformView {
  if (!report) return { label: null, unavailable: [] };
  const unavailable: Array<readonly [string, string]> = [];
  for (const id of CAPABILITY_IDS) {
    // A capability main did not report is not listed (an older main has fewer).
    const cap = report.capabilities[id] as RuntimeCapability | undefined;
    if (cap && !cap.available) unavailable.push([PV.capabilities[id], cap.reason ?? PV.noReason]);
  }
  return { label: report.label, unavailable };
}

function renderPlatform(card: HTMLElement, report: PlatformReport | undefined): void {
  const v = platformView(report);
  const note = h('p', { class: 'row-desc platform-note', text: PV.docNote });
  if (v.label === null) {
    card.replaceChildren(h('p', { class: 'muted', text: PV.unknown }), note);
    return;
  }
  card.replaceChildren(
    keyValues([[PV.label, v.label]]),
    h('h3', { class: 'surface-card-title platform-subtitle', text: PV.unavailableTitle }),
    v.unavailable.length === 0 ? h('p', { class: 'muted', text: PV.allAvailable }) : keyValues(v.unavailable),
    note,
  );
}

/** The 1 Hz poll of the Surfaces section: reads only while `element` is shown and the window is not minimised. */
export function surfacesPoll(
  api: Pick<SettingsApi, 'getSurfaceDiagnostics'>,
  timers: Timers,
  element: Pick<HTMLElement, 'hidden'>,
  onResult: (d: SurfaceDiagnostics | null) => void,
  doc: Pick<Document, 'visibilityState'> = document,
): LivePoll {
  return livePoll({
    timers,
    intervalMs: SURFACES_REFRESH_MS,
    isVisible: () => !element.hidden && doc.visibilityState !== 'hidden',
    refresh: async () => {
      try {
        onResult(await api.getSurfaceDiagnostics());
      } catch {
        onResult(null);
      }
    },
  });
}

/** The poll of the Behaviour section: same rules as the Surfaces poll, at BEHAVIOR_REFRESH_MS. */
export function behaviorPoll(
  api: Pick<SettingsApi, 'getBehaviorProfile'>,
  timers: Timers,
  element: Pick<HTMLElement, 'hidden'>,
  onResult: (p: BehaviorProfileSnapshot | null) => void,
  doc: Pick<Document, 'visibilityState'> = document,
): LivePoll {
  return livePoll({
    timers,
    intervalMs: BEHAVIOR_REFRESH_MS,
    isVisible: () => !element.hidden && doc.visibilityState !== 'hidden',
    refresh: async () => {
      try {
        onResult(await api.getBehaviorProfile());
      } catch {
        onResult(null);
      }
    },
  });
}

/** The action behind the outline switch (session-only state in main, never a setting). */
export function outlineAction(on: boolean): SettingsAction {
  return on ? 'showSurfaceOutlines' : 'hideSurfaceOutlines';
}

function countTable(d: SurfaceDiagnostics): HTMLElement {
  return h('table', { class: 'table' }, [
    h('caption', { text: V.tableCaption }),
    h('thead', {}, [
      h('tr', {}, [
        h('th', { scope: 'col', text: V.colKind }),
        h('th', { scope: 'col', text: V.colListed }),
        h('th', { scope: 'col', text: V.colAccepted }),
        h('th', { scope: 'col', text: V.colReachable }),
      ]),
    ]),
    h(
      'tbody',
      {},
      countRows(d).map((r) =>
        h('tr', {}, [
          h('th', { scope: 'row', text: r.label }),
          h('td', { class: 'num', text: r.listed }),
          h('td', { class: 'num', text: r.accepted }),
          h('td', { class: 'num', text: r.reachable }),
        ]),
      ),
    ),
  ]);
}

interface SurfacesSection {
  rows: HTMLElement[];
  render(d: SurfaceDiagnostics | null): void;
  sync(view: SettingsViewState): void;
}

function surfacesSection(ctx: PageContext): SurfacesSection {
  const verdictText = h('span', { text: V.loading });
  const verdict = h('div', { class: 'row row-block surface-verdict' }, [
    icon('info', 'surface-verdict-icon'),
    h('div', {}, [h('div', { class: 'surface-verdict-label', text: V.verdictLabel }), h('p', { class: 'surface-verdict-text', role: 'status' }, [verdictText])]),
  ]);
  const card = (title: string): { root: HTMLElement; body: HTMLElement } => {
    const body = h('div', { class: 'surface-card-body' });
    return { root: h('div', { class: 'row row-block', hidden: true }, [h('h3', { class: 'surface-card-title', text: title }), body]), body };
  };
  const seen = card(V.seenTitle);
  const tabs = card(V.tabTitle);
  const cat = card(V.catTitle);
  const coords = card(V.coordsTitle);
  const problems = card(V.errorsTitle);
  const cards = [seen, tabs, cat, coords, problems];

  const outlines = row({ title: V.outlinesTitle, desc: V.outlinesDesc, icon: 'layers' });
  const sw = toggleSwitch(outlines.titleId, outlines.describedBy);
  outlines.control.append(sw.root);
  let switching = false;
  sw.input.addEventListener('change', () => {
    const on = sw.input.checked;
    switching = true;
    sw.input.disabled = true;
    setNote(outlines.error, null, 'error');
    const fail = (detail: string): void => {
      sw.input.checked = !on;
      setNote(outlines.error, S.errors.actionFailed(detail), 'error');
    };
    void ctx.api
      .action(outlineAction(on))
      .then((res) => {
        if (!res.ok) fail(res.message ?? S.errors.unexpected);
      })
      .catch((e: unknown) => fail(errorText(e)))
      .finally(() => {
        switching = false;
        sw.input.disabled = false;
        sw.refresh();
        void ctx.refresh().catch(() => undefined);
      });
  });

  return {
    rows: [verdict, ...cards.map((c) => c.root), outlines.row],
    render(d) {
      const next = d ? d.verdict : V.unavailable;
      // Only a changed sentence is announced (the section refreshes every second).
      if (verdictText.textContent !== next) verdictText.textContent = next;
      for (const c of cards) c.root.hidden = d === null;
      if (!d) return;
      seen.body.replaceChildren(h('div', { class: 'table-wrap' }, [countTable(d)]), keyValues(seenEntries(d)));
      tabs.body.replaceChildren(keyValues(tabStripEntries(d)));
      cat.body.replaceChildren(keyValues(catEntries(d)));
      coords.body.replaceChildren(keyValues(coordinateEntries(d)));
      const errs = errorItems(d);
      problems.body.replaceChildren(errs.length === 0 ? h('p', { class: 'muted', text: V.noErrors }) : bullets(errs));
    },
    sync(view) {
      if (switching) return;
      sw.input.checked = view.status.surfaceOutlines === true;
      sw.refresh();
    },
  };
}

function timeTable(p: BehaviorProfileSnapshot): HTMLElement {
  return h('table', { class: 'table' }, [
    h('caption', { text: BV.tableCaption }),
    h('thead', {}, [h('tr', {}, [h('th', { scope: 'col', text: BV.colActivity }), h('th', { scope: 'col', text: BV.colTime }), h('th', { scope: 'col', text: BV.colShare })])]),
    h(
      'tbody',
      {},
      timeRows(p).map((r) => h('tr', {}, [h('th', { scope: 'row', text: r.label }), h('td', { class: 'num', text: r.time }), h('td', { class: 'num', text: r.share })])),
    ),
  ]);
}

/** v1.2 (ADR 0003 §11): what the cat did this session, from the profile main validated. */
function behaviorSection(): { rows: HTMLElement[]; render(p: BehaviorProfileSnapshot | null): void } {
  const statusText = h('p', { class: 'muted', role: 'status', text: BV.loading });
  const card = (title: string): { root: HTMLElement; body: HTMLElement } => {
    const body = h('div', { class: 'surface-card-body' });
    return { root: h('div', { class: 'row row-block', hidden: true }, [h('h3', { class: 'surface-card-title', text: title }), body]), body };
  };
  const session = card(BV.summaryTitle);
  const stays = card(BV.staysTitle);
  const hunts = card(BV.huntsTitle);
  const physics = card(BV.physicsTitle);
  const reactions = card(BV.reactionsTitle);
  const moods = card(BV.moodTitle);
  const cards = [session, stays, hunts, physics, reactions, moods];
  const status = h('div', { class: 'row row-block' }, [statusText]);
  return {
    rows: [status, ...cards.map((c) => c.root)],
    render(p) {
      status.hidden = p !== null;
      // Only a changed sentence is announced (the section refreshes every few seconds).
      if (p === null && statusText.textContent !== BV.unavailable) statusText.textContent = BV.unavailable;
      for (const c of cards) c.root.hidden = p === null;
      if (!p) return;
      session.body.replaceChildren(keyValues(summaryEntries(p)), h('div', { class: 'table-wrap' }, [timeTable(p)]));
      stays.body.replaceChildren(keyValues(stayEntries(p)));
      hunts.body.replaceChildren(keyValues(huntEntries(p)));
      physics.body.replaceChildren(keyValues(physicsEntries(p)));
      reactions.body.replaceChildren(h('p', { class: 'row-desc', text: reactionSummary(p) }));
      moods.body.replaceChildren(keyValues(moodEntries(p)));
    },
  };
}

export function diagnosticsPage(ctx: PageContext): PageView {
  const statusCard = h('div', { class: 'row row-block' });
  const platformCard = h('div', { class: 'row row-block' });
  const resources = h('div', { class: 'spark-row' });
  const table = h('div', { class: 'table-wrap' });
  const resourcesCard = h('div', { class: 'row row-block' }, [h('p', { class: 'row-desc', text: D.resourcesDesc }), resources, table]);

  const logLevel = segmentedRow(
    ctx,
    'diagnostics',
    'logLevel',
    (['error', 'warn', 'info', 'debug'] as const).map((v) => ({ value: v, label: D.logLevels[v] })),
    { title: D.logLevelTitle, desc: D.logLevelDesc, icon: 'diagnostic' },
  );
  const hw = toggleRow(ctx, 'diagnostics', 'hardwareAcceleration', { title: D.hwAccelTitle, desc: D.hwAccelDesc, icon: 'monitor' });
  const exp = row({ title: D.exportTitle, desc: D.exportDesc, icon: 'download' });
  const expBtn = button(D.exportButton);
  exp.control.append(expBtn);
  expBtn.addEventListener('click', () => void runAction(ctx, 'exportDiagnostics', expBtn, exp.note));
  const logs = row({ title: D.logsTitle, icon: 'folder' });
  const logsPath = h('div', { class: 'row-desc path' });
  logs.row.querySelector('.row-text')?.append(logsPath);
  const logsBtn = button(D.logsButton);
  logs.control.append(logsBtn);
  logsBtn.addEventListener('click', () => void runAction(ctx, 'openLogsFolder', logsBtn, logs.note));
  const versions = h('div', { class: 'row row-block' });
  const surfaces = surfacesSection(ctx);
  const behavior = behaviorSection();

  const element = page(D.title, [
    group(D.groupStatus, [statusCard]),
    group(PV.group, [platformCard], PV.groupDesc),
    group(V.group, surfaces.rows, V.groupDesc),
    group(BV.group, behavior.rows, BV.groupDesc),
    group(D.groupResources, [resourcesCard]),
    group(D.groupLogging, [logLevel.parts.row, hw.parts.row, exp.row, logs.row]),
    group(D.groupVersions, [versions]),
  ]);

  const render = (view: SettingsViewState): void => {
    const now = ctx.now();
    statusCard.replaceChildren(keyValues(statusEntries(view, now)));
    renderPlatform(platformCard, view.status.platform);
    resources.replaceChildren(
      spark(D.cpu, view.resources, (s) => s.cpuPercent, formatPercentValue, 5),
      spark(D.memory, view.resources, (s) => s.workingSetMB, formatMegabytes, 100),
    );
    const t = sampleTable(view.resources);
    table.replaceChildren(...(t ? [t] : []));
    logsPath.textContent = view.paths.logs;
    surfaces.sync(view);
    const v = view.versions;
    versions.replaceChildren(
      keyValues([
        [D.versions.app, v.app],
        [D.versions.electron, v.electron],
        [D.versions.chrome, v.chrome],
        [D.versions.node, v.node],
        [D.versions.os, v.os],
        [D.dataFolder, view.paths.userData],
      ]),
    );
  };
  ctx.store.subscribe(render);
  // Main broadcasts only on state changes, so uptime and resource samples are re-read while this page is open.
  const poll = pagePoll(ctx, element);
  const surfacePoll = surfacesPoll(ctx.api, ctx.timers, element, (d) => surfaces.render(d));
  const profilePoll = behaviorPoll(ctx.api, ctx.timers, element, (p) => behavior.render(p));
  return {
    id: 'diagnostics',
    title: D.title,
    element,
    onShow() {
      render(ctx.store.view);
      poll.start();
      surfacePoll.start();
      profilePoll.start();
    },
    onHide: () => {
      poll.stop();
      surfacePoll.stop();
      profilePoll.stop();
    },
  };
}
