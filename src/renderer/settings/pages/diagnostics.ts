import type { ResourceSample, SettingsViewState } from '../../../shared/ipc';
import type { PageContext, PageView } from '../context';
import { button, group, keyValues, page, row, runAction, segmentedRow, toggleRow } from '../controls';
import { h, svg, uid } from '../dom';
import { behaviorStateLabel, formatCount, formatDuration, formatElapsed, formatMegabytes, formatPercentValue, formatRelativeTime, formatSampleAge } from '../format';
import { pagePoll } from '../livePoll';
import { pauseModel } from '../privacyView';
import { niceCeil, sparkline } from '../sparkline';
import { S } from '../strings';

const D = S.diagnostics;
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
    [D.launchAtLogin, status.launchAtLoginActive ? D.active : D.inactive],
    [D.uptime, formatElapsed(status.startedAt, now)],
  );
  return entries;
}

export function diagnosticsPage(ctx: PageContext): PageView {
  const statusCard = h('div', { class: 'row row-block' });
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

  const element = page(D.title, [
    group(D.groupStatus, [statusCard]),
    group(D.groupResources, [resourcesCard]),
    group(D.groupLogging, [logLevel.parts.row, hw.parts.row, exp.row, logs.row]),
    group(D.groupVersions, [versions]),
  ]);

  const render = (view: SettingsViewState): void => {
    const now = ctx.now();
    statusCard.replaceChildren(keyValues(statusEntries(view, now)));
    resources.replaceChildren(
      spark(D.cpu, view.resources, (s) => s.cpuPercent, formatPercentValue, 5),
      spark(D.memory, view.resources, (s) => s.workingSetMB, formatMegabytes, 100),
    );
    const t = sampleTable(view.resources);
    table.replaceChildren(...(t ? [t] : []));
    logsPath.textContent = view.paths.logs;
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
  return {
    id: 'diagnostics',
    title: D.title,
    element,
    onShow() {
      render(ctx.store.view);
      poll.start();
    },
    onHide: () => poll.stop(),
  };
}
