// The target bands of ADR 0003 §14 as checks over a profile report (pure). The profile run writes
// their verdicts into its JSON (report.bands); tests/integration/behavior/bands-*.test.ts assert
// them (the short subset widened, ADR 0003 §14). Texts are the ADR's, verbatim.
import { MIN } from './metrics';
import { cellKey, type CellSpec, type CellSummary, type ProfileId, type RecoveryTrace, type RunResult } from './behaviorProfile';

export type BandId = 'B1' | 'B1b' | 'B1c' | 'B2' | 'B3' | 'B4' | 'B5' | 'B5b' | 'B5c' | 'B5d' | 'B6' | 'B7' | 'B8' | 'B8b' | 'B9' | 'B10' | 'B11' | 'B12' | 'B13' | 'B14' | 'B15' | 'C-typing' | 'C-climbs' | 'presets';

/** ADR 0003 §14, column "Band (assert)", verbatim (plus the "never in the way" ceilings and the preset order). */
export const BAND_TEXT: Readonly<Record<BandId, string>> = {
  B1: 'active share 20–35 % of awake time',
  B1b: "active share ≤ the same seed's L1 value; 1–4 edge peeks/h",
  B1c: 'active share ≤ 35 % of awake time with nothing to climb',
  B2: 'elevated arrivals 4–15 /h; ≤ 12 window climbs/h (edges excluded)',
  B3: 'stays (Kaplan–Meier, imposed ends right-censored): median 90–300 s, p10 ≥ 20 s, P(> 5 min) ≥ 8 %, P(> 15 min) monitored; plannedMs draws: median 120–200 s, p10 ≥ 30 s, ≥ 12 % > 5 min, p90 ≤ 12 min; the experienced (uncensored) median is reported',
  B4: 'departures varied on two windows: no leave kind > 70 % of own departures, ≥ 3 kinds; ≥ 2 kinds on one window',
  B5: 'hunts 4–12 /h; pounces ≥ 1 /h; never two pounces < 90 s apart',
  B5d: 'ordinary use: on average over the layouts hunts ≥ 2 /h and pounces ≥ 1 /h; never two pounces < 90 s apart',
  B5b: 'hunts ≤ 1 /h; 0 pounces within 2 s of a press or within 1 bw of a press point',
  B5c: 'every pounce and strike: `minClearanceDip` ≥ 8',
  B6: "0 hunts, pounces, swats or play near the cursor started while typing or < 3 s after (also with `reactToTyping` off); excursions 0.2–0.9 × the U-active rate",
  B7: '≥ 4 kinds over 100 throws, no kind > 50 %, hide ≤ 25 %, on the **uncapped** softmax at the REAL throw spacing; caps active in < 10 % of draws; every opt-out combination keeps ≥ 3 kinds or logs',
  B8: 'after 5 hard throws (bond ≥ 0.3): fear < 0.05, i < pre + 0.1, w < 0.05 within 10 min; within 8 min with petting at the REAL rate',
  B8b: 'w > 0.3 ≤ 15 % and i > 0.5 ≤ 10 % of awake time',
  B9: 'physics-error falls = 0',
  B10: 'deliberate slips 0.3–3 per awake hour (reinterpreted denominator, Q10)',
  B11: 'screen-edge visits 2–8 /h when nothing else is reachable (on); 0 when off; 0 without `env.edgeBands`',
  B12: 'CPU awake ≤ 1.5 % of a core, regression ≤ 0.3 pp',
  B13: 'covered strip and maximize/minimize of the support window: 0 free falls; every covered/gone end has `bailOut`',
  B14: '`stuckResets` = 0',
  B15: 'asleep 5–20 % of present time; 0.8–2.5 autonomous naps/h',
  'C-typing': 'never in the way: no hunts or play near the cursor while typing',
  'C-climbs': 'never in the way: ≤ 12 window climbs per hour',
  presets: 'active share Calm < P2 < Mischievous, Calm ≥ 10 % (informational)',
};

export type BandStatus = 'pass' | 'fail' | 'n/a';

export interface BandResult {
  id: BandId;
  /** Cell key, or a cross-cell / scenario label. */
  cell: string;
  check: string;
  value: number | string | boolean | null;
  status: BandStatus;
}

const isCell = (key: string, f: { profile?: readonly string[]; layout?: readonly string[]; user?: readonly string[]; variant?: readonly string[] }): boolean => {
  const [p, l, rest] = key.split('/');
  const [u, v] = (rest ?? '').split('+');
  return (!f.profile || f.profile.includes(p ?? '')) && (!f.layout || f.layout.includes(l ?? '')) && (!f.user || f.user.includes(u ?? '')) && (!f.variant || f.variant.includes(v ?? 'default'));
};

const inRange = (x: number | null, lo: number, hi: number): BandStatus => (x === null || !Number.isFinite(x) ? 'fail' : x >= lo && x <= hi ? 'pass' : 'fail');
const atLeast = (x: number | null, lo: number): BandStatus => (x === null || !Number.isFinite(x) ? 'fail' : x >= lo ? 'pass' : 'fail');
const atMost = (x: number | null, hi: number): BandStatus => (x === null || !Number.isFinite(x) ? 'fail' : x <= hi ? 'pass' : 'fail');
const zero = (x: number): BandStatus => (x === 0 ? 'pass' : 'fail');

/** Range bands a check can be stated with (the short subset passes widened ones). */
export interface BandLimits {
  activeShare: readonly [number, number];
  /** B1c: with nothing to climb (L4, L4b). */
  activeShareNothingToClimbMax: number;
  arrivalsPerHour: readonly [number, number];
  windowClimbsMaxPerHour: number;
  kmMedianS: readonly [number, number];
  kmP10MinS: number;
  kmOver5MinMin: number;
  plannedMedianS: readonly [number, number];
  plannedP10MinS: number;
  plannedOver5MinMin: number;
  plannedP90MaxS: number;
  leaveMaxShare: number;
  leaveMinKinds: number;
  asleepShareOfPresent: readonly [number, number];
  napsPerPresentHour: readonly [number, number];
  waryMax: number;
  irritableMax: number;
  slipsPerAwakeHour: readonly [number, number];
}

export const FULL_LIMITS: BandLimits = {
  activeShare: [0.2, 0.35],
  activeShareNothingToClimbMax: 0.35,
  arrivalsPerHour: [4, 15],
  windowClimbsMaxPerHour: 12,
  kmMedianS: [90, 300],
  kmP10MinS: 20,
  kmOver5MinMin: 0.08,
  plannedMedianS: [120, 200],
  plannedP10MinS: 30,
  plannedOver5MinMin: 0.12,
  plannedP90MaxS: 720,
  leaveMaxShare: 0.7,
  leaveMinKinds: 3,
  asleepShareOfPresent: [0.05, 0.2],
  napsPerPresentHour: [0.8, 2.5],
  waryMax: 0.15,
  irritableMax: 0.1,
  slipsPerAwakeHour: [0.3, 3],
};

/** One cell's §14 checks that need no other cell (B1-B4, B5-B5c, B6's zero counts, B8b, B9, B10, B11, B13-B15). */
export function cellChecks(key: string, c: CellSummary, lim: BandLimits = FULL_LIMITS): BandResult[] {
  const out: BandResult[] = [];
  const push = (id: BandId, check: string, value: BandResult['value'], status: BandStatus): void => void out.push({ id, cell: key, check, value, status });
  const activeUser = isCell(key, { user: ['U-active'], variant: ['default'] });
  if (activeUser && isCell(key, { profile: ['P1', 'P2'], layout: ['L1', 'L2', 'L3'] })) {
    push('B1', `active share in [${lim.activeShare.join(', ')}]`, c.activeShare, inRange(c.activeShare, lim.activeShare[0], lim.activeShare[1]));
    push('B15', `asleep share of present time in [${lim.asleepShareOfPresent.join(', ')}]`, c.sleep.asleepShareOfPresent, inRange(c.sleep.asleepShareOfPresent, lim.asleepShareOfPresent[0], lim.asleepShareOfPresent[1]));
    push('B15', `autonomous naps per present hour in [${lim.napsPerPresentHour.join(', ')}]`, c.sleep.napsPerPresentHour, inRange(c.sleep.napsPerPresentHour, lim.napsPerPresentHour[0], lim.napsPerPresentHour[1]));
  }
  if (activeUser && isCell(key, { profile: ['P1', 'P2'], layout: ['L1', 'L2'] })) {
    push('B2', `own elevated arrivals per hour in [${lim.arrivalsPerHour.join(', ')}]`, c.stays.ownArrivalsPerHour, inRange(c.stays.ownArrivalsPerHour, lim.arrivalsPerHour[0], lim.arrivalsPerHour[1]));
    push('B3', `Kaplan-Meier median (s) in [${lim.kmMedianS.join(', ')}]`, c.stays.km.median, inRange(c.stays.km.median, lim.kmMedianS[0], lim.kmMedianS[1]));
    push('B3', `Kaplan-Meier p10 (s) >= ${lim.kmP10MinS}`, c.stays.km.p10, atLeast(c.stays.km.p10, lim.kmP10MinS));
    push('B3', `Kaplan-Meier P(> 5 min) >= ${lim.kmOver5MinMin}`, c.stays.km.pOver5min, atLeast(c.stays.km.pOver5min, lim.kmOver5MinMin));
    push('B3', 'Kaplan-Meier P(> 15 min), monitored: flat after its last event under REAL-rate handling', c.stays.km.pOver15min, 'n/a');
    push('B3', `plannedMs median (s) in [${lim.plannedMedianS.join(', ')}]`, c.stays.planned.median, inRange(c.stays.planned.median, lim.plannedMedianS[0], lim.plannedMedianS[1]));
    push('B3', `plannedMs p10 (s) >= ${lim.plannedP10MinS}`, c.stays.planned.p10, atLeast(c.stays.planned.p10, lim.plannedP10MinS));
    push('B3', `plannedMs share > 5 min >= ${lim.plannedOver5MinMin}`, c.stays.planned.n ? c.stays.planned.over5minShare : null, atLeast(c.stays.planned.n ? c.stays.planned.over5minShare : null, lim.plannedOver5MinMin));
    push('B3', `plannedMs p90 (s) <= ${lim.plannedP90MaxS}`, c.stays.planned.p90, atMost(c.stays.planned.p90, lim.plannedP90MaxS));
    push('B3', 'experienced (uncensored) median, s (reported)', c.stays.experiencedMedianS, 'n/a');
    // B4 proper is on the two-window layout below: one tall window structurally offers two ways down (§6.3).
    push('B4', 'share of the commonest leave kind on one window (reported)', c.stays.leave.maxShare, 'n/a');
    push('B4', 'at least 2 leave kinds on one window', c.stays.leave.kinds, atLeast(c.stays.leave.kinds, 2));
    push('B10', `deliberate slips per awake hour in [${lim.slipsPerAwakeHour.join(', ')}]`, c.slips.perAwakeHour, inRange(c.slips.perAwakeHour, lim.slipsPerAwakeHour[0], lim.slipsPerAwakeHour[1]));
  }
  if (activeUser && isCell(key, { profile: ['P1', 'P2'], layout: ['L5'] })) {
    push('B4', `no leave kind above ${lim.leaveMaxShare} of own departures`, c.stays.leave.maxShare, c.stays.leave.departures ? atMost(c.stays.leave.maxShare, lim.leaveMaxShare) : 'fail');
    push('B4', `at least ${lim.leaveMinKinds} leave kinds`, c.stays.leave.kinds, atLeast(c.stays.leave.kinds, lim.leaveMinKinds));
  }
  if (activeUser && isCell(key, { profile: ['P1', 'P2'], layout: ['L4', 'L4b'] })) {
    push('B1c', `active share <= ${lim.activeShareNothingToClimbMax} with nothing to climb`, c.activeShare, atMost(c.activeShare, lim.activeShareNothingToClimbMax));
  }
  if (activeUser && isCell(key, { profile: ['P1', 'P2'] })) {
    push('B5d', 'smallest gap between two pounces >= 90 s', c.hunts.minPounceGapS, c.hunts.minPounceGapS === null ? 'n/a' : atLeast(c.hunts.minPounceGapS, 90));
  }
  if (activeUser) {
    push('B8b', `wary (w > 0.3) share of awake <= ${lim.waryMax}`, c.moods.waryShare, atMost(c.moods.waryShare, lim.waryMax));
    push('B8b', `irritable (i > 0.5) share of awake <= ${lim.irritableMax}`, c.moods.irritableShare, atMost(c.moods.irritableShare, lim.irritableMax));
  }
  if (isCell(key, { user: ['U-play'] })) {
    push('B5', 'hunts per hour in [4, 12]', c.hunts.perHour, inRange(c.hunts.perHour, 4, 12));
    push('B5', 'pounces per hour >= 1', c.hunts.pouncesPerHour, atLeast(c.hunts.pouncesPerHour, 1));
    push('B5', 'smallest gap between two pounces >= 90 s', c.hunts.minPounceGapS, c.hunts.minPounceGapS === null ? 'pass' : atLeast(c.hunts.minPounceGapS, 90));
  }
  if (isCell(key, { user: ['U-mouse-work'] })) {
    push('B5b', 'hunts per hour <= 1', c.hunts.perHour, atMost(c.hunts.perHour, 1));
    push('B5b', 'pounces within 2 s after a press = 0', c.hunts.pouncesNearPress, zero(c.hunts.pouncesNearPress));
    push('B5b', 'pounce landings within 1 bw of a recent press point = 0', c.hunts.pounceLandingsNearPressPoint, zero(c.hunts.pounceLandingsNearPressPoint));
  }
  if (c.hunts.count > 0 || c.strikes.byClip.pounce || c.strikes.byClip.swat) {
    push('B5c', 'smallest minClearanceDip of any pounce or strike >= 8', c.hunts.minClearanceDip, c.hunts.minClearanceDip === null ? 'n/a' : atLeast(c.hunts.minClearanceDip, 8));
  }
  if (isCell(key, { user: ['U-typing'] })) {
    push('B6', 'hunts started while typing or < 3 s after = 0', c.hunts.startedWhileTyping, zero(c.hunts.startedWhileTyping));
    push('B6', 'pounces while typing or < 3 s after = 0', c.hunts.pouncesWhileTyping, zero(c.hunts.pouncesWhileTyping));
    push('B6', 'strikes (pounce, swat, pawAt) near the cursor while typing or < 3 s after = 0', c.strikes.whileTypingNearCursor, zero(c.strikes.whileTypingNearCursor));
    push('B6', 'play or chase near the cursor started while typing or < 3 s after = 0', c.strikes.playNearCursorWhileTyping, zero(c.strikes.playNearCursorWhileTyping));
  }
  // The "never in the way" ceilings hold in every cell.
  push('C-typing', 'hunts and pounces started while typing or < 3 s after = 0', c.hunts.startedWhileTyping + c.hunts.pouncesWhileTyping, zero(c.hunts.startedWhileTyping + c.hunts.pouncesWhileTyping));
  push('C-climbs', 'window climbs per hour <= 12', c.stays.windowClimbsPerHour, atMost(c.stays.windowClimbsPerHour, lim.windowClimbsMaxPerHour));
  if (isCell(key, { layout: ['L4'], user: ['U-active'] })) {
    const v = key.includes('+') ? key.split('+')[1] : 'default';
    if (v === 'default') push('B11', 'screen-edge visits per hour in [2, 8] (setting on, bands present)', c.edges.visitsPerHour, inRange(c.edges.visitsPerHour, 2, 8));
    if (v === 'edgesOff') push('B11', 'screen-edge visits = 0 with the setting off', c.edges.visits, zero(c.edges.visits));
    if (v === 'noEdgeBands') push('B11', 'screen-edge visits = 0 without env.edgeBands', c.edges.visits, zero(c.edges.visits));
  }
  if (isCell(key, { layout: ['L3c'] })) {
    const free = (c.falls.byCause.covered ?? 0) + (c.falls.byCause.gone ?? 0) + (c.falls.byCause.physics ?? 0);
    push('B13', 'free falls (covered, gone, physics) under strip churn = 0', free, zero(free));
    push('B13', 'every covered / gone stay end has a bailOut', `${c.stays.imposedLoss.withBailOut}/${c.stays.imposedLoss.n}`, c.stays.imposedLoss.n === 0 ? 'fail' : c.stays.imposedLoss.withBailOut === c.stays.imposedLoss.n ? 'pass' : 'fail');
  }
  push('B9', 'physics-error falls = 0', c.falls.physicsErrors, zero(c.falls.physicsErrors));
  push('B14', 'stuckResets = 0', c.stuckResets, zero(c.stuckResets));
  return out;
}

/** Bands that compare cells: B1b (L4b vs the same seed's L1), B6's excursion ratio, the preset order. */
export function crossCellChecks(cells: Readonly<Record<string, CellSummary>>): BandResult[] {
  const out: BandResult[] = [];
  for (const p of ['P1', 'P2'] as ProfileId[]) {
    const l4b = cells[cellKey({ profile: p, layout: 'L4b', user: 'U-active' })];
    const l1 = cells[cellKey({ profile: p, layout: 'L1', user: 'U-active' })];
    if (l4b && l1) {
      const worse = Object.entries(l4b.activeShareBySeed).filter(([seed, v]) => {
        const ref = l1.activeShareBySeed[seed];
        return ref !== undefined && v > ref;
      });
      out.push({ id: 'B1b', cell: `${p}/L4b vs ${p}/L1 (U-active)`, check: "active share <= the same seed's L1 value (seeds above)", value: worse.map(([s]) => s).join(',') || 'none', status: worse.length === 0 ? 'pass' : 'fail' });
      out.push({ id: 'B1b', cell: `${p}/L4b/U-active`, check: 'covered-band edge peeks per hour in [1, 4]', value: l4b.edges.peeksPerHour, status: inRange(l4b.edges.peeksPerHour, 1, 4) });
    }
    // B5d: ordinary use, on average over the layouts with something in reach (L4 has no window to work in).
    const ordinary = (['L1', 'L2', 'L3', 'L4b'] as const).map((layout) => cells[cellKey({ profile: p, layout, user: 'U-active' })]).filter((c): c is CellSummary => c !== undefined);
    if (ordinary.length > 0) {
      const mean = (f: (c: CellSummary) => number): number => Math.round((100 * ordinary.reduce((a, c) => a + f(c), 0)) / ordinary.length) / 100;
      out.push({ id: 'B5d', cell: `${p} x ${ordinary.length} layouts (U-active)`, check: 'mean hunts per hour >= 2', value: mean((c) => c.hunts.perHour), status: atLeast(mean((c) => c.hunts.perHour), 2) });
      out.push({ id: 'B5d', cell: `${p} x ${ordinary.length} layouts (U-active)`, check: 'mean pounces per hour >= 1', value: mean((c) => c.hunts.pouncesPerHour), status: atLeast(mean((c) => c.hunts.pouncesPerHour), 1) });
    }
    const active = l1?.stays.ownArrivalsPerHour;
    for (const v of ['default', 'typingReactionsOff'] as const) {
      const typing = cells[cellKey({ profile: p, layout: 'L1', user: 'U-typing', variant: v })];
      if (!typing || active === undefined) continue;
      const r = active > 0 ? Math.round((typing.stays.ownArrivalsPerHour / active) * 1000) / 1000 : null;
      out.push({ id: 'B6', cell: `${cellKey({ profile: p, layout: 'L1', user: 'U-typing', variant: v })} vs ${p}/L1/U-active`, check: 'excursions 0.2-0.9 x the U-active rate', value: r, status: inRange(r, 0.2, 0.9) });
    }
  }
  const calm = cells['Calm/L1/U-active'];
  const p2 = cells['P2/L1/U-active'];
  const mis = cells['Mischievous/L1/U-active'];
  if (calm && p2 && mis) {
    out.push({ id: 'presets', cell: 'Calm / P2 / Mischievous, L1 U-active', check: 'active share Calm < P2 < Mischievous', value: `${calm.activeShare} / ${p2.activeShare} / ${mis.activeShare}`, status: calm.activeShare < p2.activeShare && p2.activeShare < mis.activeShare ? 'pass' : 'fail' });
    out.push({ id: 'presets', cell: 'Calm/L1/U-active', check: 'Calm active share >= 0.10', value: calm.activeShare, status: atLeast(calm.activeShare, 0.1) });
  }
  return out;
}

// ------------------------------------------------------------------ scenarios

/** B7 over one Monte Carlo run: the first `throws` reactions. */
export function throwMonteCarloChecks(label: string, run: RunResult, throws = 100): BandResult[] {
  const rs = run.records.reactions.slice(0, throws);
  const kinds: Record<string, number> = {};
  for (const r of rs) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const n = rs.length;
  const max = n ? Math.max(...Object.values(kinds)) / n : 0;
  const hide = n ? (kinds.hide ?? 0) / n : 0;
  const capped = n ? rs.filter((r) => r.capped).length / n : 0;
  const k = Object.keys(kinds).length;
  return [
    { id: 'B7', cell: label, check: `${throws} reactions recorded`, value: n, status: n >= throws ? 'pass' : 'fail' },
    { id: 'B7', cell: label, check: '>= 4 kinds', value: k, status: atLeast(k, 4) },
    { id: 'B7', cell: label, check: 'no kind > 50 %', value: Math.round(max * 1000) / 1000, status: n ? atMost(max, 0.5) : 'fail' },
    { id: 'B7', cell: label, check: 'hide <= 25 %', value: Math.round(hide * 1000) / 1000, status: n ? atMost(hide, 0.25) : 'fail' },
    { id: 'B7', cell: label, check: 'caps active in < 10 % of draws', value: Math.round(capped * 1000) / 1000, status: n ? (capped < 0.1 ? 'pass' : 'fail') : 'fail' },
  ];
}

/** B8 over one recovery trace: the drives `withinMin` minutes after the last throw. */
export function recoveryChecks(label: string, tr: RecoveryTrace, withinMin: number): BandResult[] {
  const at = tr.burstEndMs + withinMin * MIN;
  const s = tr.samples.find((x) => x.t >= at) ?? tr.samples[tr.samples.length - 1] ?? null;
  const thrown = tr.run.records.releases.filter((r) => r.kind === 'throw' && r.thrown).length;
  // Not vacuous: the burst must have registered (a recovery from nothing proves nothing).
  const peak = tr.samples.slice(0, 60).reduce((m, x) => Math.max(m, x.fear, x.wariness), 0);
  return [
    { id: 'B8', cell: label, check: '5 hard throws counted', value: thrown, status: thrown >= 5 ? 'pass' : 'fail' },
    { id: 'B8', cell: label, check: 'the burst registered: peak fear or wariness >= 0.1 in the minute after it', value: Math.round(peak * 1000) / 1000, status: peak >= 0.1 ? 'pass' : 'fail' },
    { id: 'B8', cell: label, check: `fear < 0.05 after ${withinMin} min`, value: s ? Math.round(s.fear * 1000) / 1000 : null, status: s && s.fear < 0.05 ? 'pass' : 'fail' },
    { id: 'B8', cell: label, check: `irritability < pre + 0.1 after ${withinMin} min`, value: s ? `${Math.round(s.irritability * 1000) / 1000} (pre ${Math.round(tr.pre.irritability * 1000) / 1000})` : null, status: s && s.irritability < tr.pre.irritability + 0.1 ? 'pass' : 'fail' },
    { id: 'B8', cell: label, check: `wariness < 0.05 after ${withinMin} min`, value: s ? Math.round(s.wariness * 1000) / 1000 : null, status: s && s.wariness < 0.05 ? 'pass' : 'fail' },
  ];
}

/** Every band over a report's cells (and its scenarios if run). B12 is the REAL bench, never here. */
export function evaluateBands(cells: Readonly<Record<string, CellSummary>>, extra: BandResult[] = []): BandResult[] {
  const out: BandResult[] = [];
  for (const [key, c] of Object.entries(cells)) out.push(...cellChecks(key, c));
  out.push(...crossCellChecks(cells), ...extra);
  out.push({ id: 'B12', cell: 'REAL bench', check: BAND_TEXT.B12, value: null, status: 'n/a' });
  return out;
}

/** Counts by status per band id (for the report header). */
export function bandTally(results: readonly BandResult[]): Record<string, Record<BandStatus, number>> {
  const t: Record<string, Record<BandStatus, number>> = {};
  for (const r of results) {
    const e = (t[r.id] ??= { pass: 0, fail: 0, 'n/a': 0 });
    e[r.status]++;
  }
  return t;
}

/** The cells a band needs, for running a partial matrix. */
export const BAND_CELLS: Readonly<Partial<Record<BandId, readonly CellSpec[]>>> = {
  B1: ['P1', 'P2'].flatMap((profile) => ['L1', 'L2', 'L3'].map((layout) => ({ profile, layout, user: 'U-active' }) as CellSpec)),
  B11: [
    { profile: 'P2', layout: 'L4', user: 'U-active' },
    { profile: 'P2', layout: 'L4', user: 'U-active', variant: 'edgesOff' },
    { profile: 'P2', layout: 'L4', user: 'U-active', variant: 'noEdgeBands' },
  ],
  B13: [{ profile: 'P2', layout: 'L3c', user: 'U-active' }],
};
