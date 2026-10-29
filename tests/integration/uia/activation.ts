// Web-content accessibility check for the REAL tab-strip probe (probe.ts). Pure: no processes.
//
// Asking a web-content node for ControlType, ClassName or Name switches on the browser's web
// accessibility for good. The cost scales with the active page and lands mostly in that page's
// renderer process (docs/research/v1.1/uia-tabs.md §2: +29.5 / +35.9 MB in the heavy renderer; a
// review run on Edge 156 saw the renderer go 166.4 -> 210.1 MB while the browser process stayed at
// 62.1 MB). On about:blank tabs a naive query costs almost nothing anywhere. So the probe makes the
// active tab heavy, samples every process of its own instance before and after the UIA phase and
// fails when any one of them grew past the threshold; a positive control (a naive descendant query
// on a second throwaway instance) shows that the same measurement does see an activation.

export interface ProcSample {
  pid: number;
  privateMB: number;
  cpuMs: number;
}

export interface ProcDelta {
  pid: number;
  beforeMB: number;
  afterMB: number;
  growthMB: number;
  cpuMs: number;
}

export interface ActivationCheck {
  thresholdMB: number;
  /** Largest private-memory growth of one process present in both samples (0 when none). */
  maxGrowthMB: number;
  pid: number | null;
  detected: boolean;
  /** Every process present in both samples, largest growth first. */
  deltas: ProcDelta[];
}

/**
 * Growth of any one instance process (private MB) that counts as an activation. Idle drift of a
 * settled instance stays within a few MB; an activation added about +30..+45 MB to the renderer.
 */
export const ACTIVATION_GROWTH_MB = 12;

/** Paragraphs on the probe's active page (as in the research). */
export const HEAVY_PARAGRAPHS = 20_000;

/** Windows command lines hold at most 32 767 chars; the URL is one argument among a few. */
export const MAX_URL_CHARS = 8_000;

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Per-process change between two samples of the same instance (processes in both only). */
export function processDeltas(before: readonly ProcSample[], after: readonly ProcSample[]): ProcDelta[] {
  const prev = new Map(before.map((p) => [p.pid, p]));
  const out: ProcDelta[] = [];
  for (const a of after) {
    const b = prev.get(a.pid);
    if (b === undefined) continue;
    out.push({ pid: a.pid, beforeMB: b.privateMB, afterMB: a.privateMB, growthMB: round1(a.privateMB - b.privateMB), cpuMs: Math.max(0, a.cpuMs - b.cpuMs) });
  }
  return out.sort((x, y) => y.growthMB - x.growthMB || x.pid - y.pid);
}

export function checkActivation(before: readonly ProcSample[], after: readonly ProcSample[], thresholdMB = ACTIVATION_GROWTH_MB): ActivationCheck {
  const deltas = processDeltas(before, after);
  const top = deltas[0];
  const maxGrowthMB = top !== undefined ? Math.max(0, top.growthMB) : 0;
  return { thresholdMB, maxGrowthMB, pid: top !== undefined && top.growthMB > 0 ? top.pid : null, detected: maxGrowthMB > thresholdMB, deltas };
}

/** Same processes, and none moved by more than `toleranceMB` between the two samples. */
export function settled(prev: readonly ProcSample[], next: readonly ProcSample[], toleranceMB: number): boolean {
  if (prev.length === 0 || prev.length !== next.length) return false;
  const deltas = processDeltas(prev, next);
  return deltas.length === next.length && deltas.every((d) => Math.abs(d.growthMB) <= toleranceMB);
}

/** data: URL of a page that builds `paragraphs` paragraphs of text (a large accessibility tree). */
export function heavyPageUrl(paragraphs = HEAVY_PARAGRAPHS): string {
  const n = Math.max(1, Math.floor(paragraphs));
  const html =
    '<!doctype html><meta charset="utf-8"><body><script>' +
    `for(let i=0;i<${n};i++){const p=document.createElement('p');p.textContent='Paragraph '+i+' of the tab-strip probe page, lorem ipsum dolor sit amet.';document.body.appendChild(p)}` +
    '</script></body>';
  return `data:text/html,${encodeURIComponent(html)}`;
}
