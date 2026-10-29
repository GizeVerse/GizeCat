// DOM-free view model of the Diagnostics page's Surfaces section (v1.1.1): turns a
// SurfaceDiagnostics from main into labelled rows. Host-clock times are shown relative to
// the object's own `at` (same clock); the sim clock (lastElevatedAt) as time since start.
import type { Rect } from '../../shared/geometry';
import { DECISION_TARGETS, type SurfaceCounts, type SurfaceDiagnostics } from '../../shared/surfaceDiagnostics';
import type { SurfaceKind } from '../../shared/surfaces';
import { behaviorStateLabel, formatCount, formatDecimal, formatDuration, formatMultiplier, formatPercent, formatRelativeTime } from './format';
import { S } from './strings';

const V = S.diagnostics.surfaces;

export type Entry = readonly [string, string];

/** Table order: what lifts the cat off the floor first. */
export const KIND_ORDER = ['windowTop', 'windowSide', 'tabStrip', 'taskbar'] as const satisfies readonly SurfaceKind[];

export interface CountRow {
  kind: SurfaceKind;
  label: string;
  listed: string;
  accepted: string;
  reachable: string;
}

export function countRows(d: SurfaceDiagnostics): CountRow[] {
  const c = (counts: SurfaceCounts, k: SurfaceKind): string => formatCount(counts[k]);
  return KIND_ORDER.map((k) => ({ kind: k, label: V.kinds[k], listed: c(d.provider.listed, k), accepted: c(d.nav.accepted, k), reachable: c(d.nav.reachable, k) }));
}

/** "Covered by other windows 3 · Minimized 1", largest first; "None" when empty. */
export function reasonList<R extends string>(counts: Partial<Record<R, number>>, labels: Record<R, string>): string {
  const items = (Object.entries(counts) as Array<[R, number | undefined]>)
    .filter((e): e is [R, number] => typeof e[1] === 'number' && e[1] > 0 && Object.hasOwn(labels, e[0]))
    .sort((a, b) => b[1] - a[1]);
  if (items.length === 0) return V.none;
  return items.map(([r, n]) => V.reasonCount(labels[r], n)).join(' · ');
}

const when = (at: number, now: number): string => (at > 0 ? formatRelativeTime(at, now) : S.common.never);
const yesNo = (v: boolean): string => (v ? S.common.yes : S.common.no);

export function seenEntries(d: SurfaceDiagnostics): Entry[] {
  const p = d.provider;
  return [
    [V.windowsTracked, formatCount(p.windowsConsidered)],
    [V.windowsWithEdges, formatCount(p.windowsWithSurfaces)],
    [V.frontMaximized, yesNo(p.frontMaximized)],
    [V.skipped, reasonList(p.skipped, V.skipReasons)],
    [V.rejected, reasonList(d.nav.rejected, V.rejectReasons)],
    [V.lastScan, when(p.lastRefreshAt, d.at)],
  ];
}

export function tabStripEntries(d: SurfaceDiagnostics): Entry[] {
  const t = d.provider.tabStrips;
  return [
    [V.tabState, V.tabStates[t.state]],
    [V.helper, t.helperRunning ? V.running : V.stopped],
    [V.interest, formatCount(t.interest)],
    [V.strips, formatCount(t.strips)],
    [V.reads, formatCount(t.reads)],
    [V.readErrors, formatCount(t.errors)],
    [V.lastRead, when(t.lastReadAt, d.at)],
    [V.lastRejection, t.lastRejection ?? V.none],
  ];
}

export function catEntries(d: SurfaceDiagnostics): Entry[] {
  const c = d.decision;
  const n = d.nav.climbs;
  return [
    [V.state, behaviorStateLabel(c.state)],
    [V.support, V.supports[c.support]],
    [V.target, c.targetKind === null ? V.noTarget : V.targetKinds[c.targetKind]],
    ...DECISION_TARGETS.map((t): Entry => [V.targets[t], V.availability[c.targets[t]]]),
    [V.urge, formatPercent(c.exploreUrge)],
    [V.excursions, formatCount(c.excursions)],
    [V.lastElevated, c.lastElevatedAt > 0 ? V.afterStart(formatDuration(c.lastElevatedAt / 1000)) : S.common.never],
    [V.climbs, V.climbsValue(n.leaps, n.mounts, n.pulledUp, n.reversed)],
  ];
}

const px = (v: number): string => formatCount(v);
const rectText = (r: Rect, fmt: (v: number) => string): string => V.rect(fmt(r.x), fmt(r.y), fmt(r.width), fmt(r.height));
const dip = (v: number): string => (Number.isInteger(v) ? formatCount(v) : formatDecimal(v, 1));

export function coordinateEntries(d: SurfaceDiagnostics): Entry[] {
  const c = d.coordinates;
  const entries: Entry[] = [[V.dpi, c.dpiAwareness]];
  c.displays.forEach((disp, i) => {
    entries.push([V.display(i + 1, disp.primary), V.displayValue(formatMultiplier(disp.scale), rectText(disp.workAreaPx, px), rectText(disp.workAreaDip, dip))]);
  });
  entries.push([V.catPosition, c.cat.displayId === null ? S.format.missing : V.point(px(c.cat.xPx), px(c.cat.yPx))]);
  entries.push([V.floor, c.cat.floorYPx === null ? S.format.missing : V.floorValue(px(c.cat.floorYPx))]);
  return entries;
}

/** Newest first. */
export function errorItems(d: SurfaceDiagnostics): string[] {
  return [...d.provider.recentErrors].reverse().map((e) => V.errorItem(e.kind, e.source, when(e.at, d.at)));
}
