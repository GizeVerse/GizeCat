// Tab-strip geometry fixtures from docs/research/v1.1/uia-tabs.md §2 (Edge 156 / Chrome 155 on
// Windows 11, measured at 125 % = 120 dpi with --window-position=100,100 --window-size=1100,700).
// The 3-tab 125 % layouts and the maximized Edge layout are the measured numbers. The 24-tab
// layouts are built from the measured facts (64-67 px tabs, Edge new-tab button at 1093; Chrome by
// analogy), and 100 % / 150 % are the 125 % layouts scaled and rounded to px (SIMULATED).
import type { WireStrip } from '../../../src/main/uia/protocol';
import type { StripGeometry } from '../../../src/main/uia/segment';

type R = [number, number, number, number];

interface Layout {
  frame: R;
  /** Rects relative to the frame's top-left. */
  leftButton: R;
  container: R;
  tabs: R[];
  newTab: R;
  grab: R;
  captions: R;
}

const MEASURED_FRAME: R = [133, 125, 1359, 867];
const WORK: R = [0, 0, 1920, 1200];

function threeTabs(x: number[], w: number): R[] {
  return x.map((tx) => [tx, 0, w, 52] as R);
}

function edge(tabCount: 3 | 24): Layout {
  if (tabCount === 3) {
    return {
      frame: MEASURED_FRAME,
      leftButton: [6, 0, 40, 45],
      container: [41, 0, 918, 52],
      tabs: threeTabs([41, 340, 638], 320),
      newTab: [953, 0, 40, 52],
      grab: [993, 0, 193, 52],
      captions: [1186, 1, 173, 49],
    };
  }
  // 24 tabs, 66 px wide, neighbours overlapping; the new-tab button moved to x = 1093.
  const tabs: R[] = [];
  for (let i = 0; i < 24; i++) tabs.push([41 + Math.round(i * 43.1), 0, 66, 52]);
  return {
    frame: MEASURED_FRAME,
    leftButton: [6, 0, 40, 45],
    container: [41, 0, 1052, 52],
    tabs,
    newTab: [1093, 0, 40, 52],
    grab: [1133, 0, 53, 52],
    captions: [1186, 1, 173, 49],
  };
}

function chrome(tabCount: 3 | 24): Layout {
  if (tabCount === 3) {
    return {
      frame: MEASURED_FRAME,
      leftButton: [8, 0, 36, 52],
      container: [36, 0, 916, 52],
      tabs: threeTabs([36, 333, 631], 320),
      newTab: [943, 0, 36, 52],
      grab: [993, 0, 194, 52],
      captions: [1187, 1, 172, 49],
    };
  }
  // 24 tabs (SIMULATED by analogy with Edge: 66 px tabs; new-tab button 8 px inside the last tab).
  const tabs: R[] = [];
  for (let i = 0; i < 24; i++) tabs.push([36 + Math.round(i * 43.1), 0, 66, 52]);
  return {
    frame: MEASURED_FRAME,
    leftButton: [8, 0, 36, 52],
    container: [36, 0, 1057, 52],
    tabs,
    newTab: [1085, 0, 36, 52],
    grab: [1121, 0, 66, 52],
    captions: [1187, 1, 172, 49],
  };
}

export interface FixtureOptions {
  browser: 'edge' | 'chrome';
  /** 1, 1.25 or 1.5. */
  scale?: number;
  tabs?: 3 | 24;
  /** Index of the selected tab (default: last). */
  selected?: number | null;
  /** Frame top-left override (absolute px), keeping the size. */
  at?: { x: number; y: number };
  vertical?: boolean;
  maximized?: boolean;
}

/** A strip as the helper sends it (absolute physical px). */
export function wireStrip(o: FixtureOptions): WireStrip {
  const scale = o.scale ?? 1.25;
  const k = scale / 1.25;
  const dpi = Math.round(96 * scale);
  if (o.maximized) {
    // Measured (Edge, 125 %): frame [0,0,1920,1200], tabs from x=40, new tab at 1655,
    // grab handle 1695-1748, captions 1748-1920.
    const tabs = [40, 339, 638].map((x, i) => ({ x, y: 0, w: 320, h: 52, selected: i === 2 }));
    return {
      frame: { x: 0, y: 0, w: 1920, h: 1200 },
      work: { x: 0, y: 0, w: 1920, h: 1200 },
      dpi: 120,
      container: { x: 40, y: 0, w: 1600, h: 52 },
      tabs,
      count: 3,
      leftButton: { x: 5, y: 0, w: 35, h: 45 },
      newTab: { x: 1655, y: 0, w: 40, h: 52 },
      grab: { x: 1695, y: 0, w: 53, h: 52 },
      captions: { x: 1748, y: 0, w: 172, h: 49 },
      maximized: true,
      vertical: false,
      path: 'class',
      ms: 0.4,
    };
  }
  const L = o.browser === 'edge' ? edge(o.tabs ?? 3) : chrome(o.tabs ?? 3);
  const fx = o.at?.x ?? Math.round(L.frame[0] * k);
  const fy = o.at?.y ?? Math.round(L.frame[1] * k);
  const frame = { x: fx, y: fy, w: Math.round(L.frame[2] * k), h: Math.round(L.frame[3] * k) };
  const place = (r: R) => ({ x: fx + Math.round(r[0] * k), y: fy + Math.round(r[1] * k), w: Math.round(r[2] * k), h: Math.round(r[3] * k) });
  const selected = o.selected === undefined ? L.tabs.length - 1 : o.selected;
  return {
    frame,
    work: { x: WORK[0], y: WORK[1], w: WORK[2], h: WORK[3] },
    dpi,
    container: o.vertical ? null : place(L.container),
    tabs: o.vertical ? [] : L.tabs.map((t, i) => ({ ...place(t), selected: i === selected })),
    count: o.vertical ? 0 : L.tabs.length,
    leftButton: o.vertical ? null : place(L.leftButton),
    newTab: o.vertical ? null : place(L.newTab),
    grab: o.vertical ? null : place(L.grab),
    captions: place(L.captions),
    maximized: false,
    vertical: o.vertical ?? false,
    path: 'class',
    ms: 0.35,
  };
}

const rect = (r: { x: number; y: number; w: number; h: number } | null) => (r === null ? null : { x: r.x, y: r.y, width: r.w, height: r.h });

export function geometry(o: FixtureOptions): StripGeometry {
  const w = wireStrip(o);
  return {
    frame: rect(w.frame)!,
    work: rect(w.work),
    dpi: w.dpi,
    container: rect(w.container),
    tabs: w.tabs.map((t) => ({ x: t.x, y: t.y, width: t.w, height: t.h, selected: t.selected })),
    count: w.count,
    leftButton: rect(w.leftButton),
    newTab: rect(w.newTab),
    grab: rect(w.grab),
    captions: rect(w.captions),
    maximized: w.maximized,
    vertical: w.vertical,
  };
}
