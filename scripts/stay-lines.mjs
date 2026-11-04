// Reads the app's 'stay ended' log lines (ADR 0003 §11): kinds and durations of finished stays on a
// window top or tab strip, nothing else. Used by the packaged-build check, where hooks do not exist.

const count = (map, key) => {
  const k = key ?? 'none';
  map[k] = (map[k] ?? 0) + 1;
};

/** The stays in a parsed log (objects with m, t, d). Lines the rate limit dropped are only counted. */
export function staysFromLog(lines) {
  return lines
    .filter((l) => l.m === 'stay ended' && l.d)
    .map((l) => ({
      t: l.t,
      kind: l.d.kind ?? 'other',
      dwellS: l.d.dwellS,
      plannedS: l.d.plannedS ?? null,
      reason: l.d.reason ?? 'other',
      leave: l.d.leave ?? null,
      arrivedBy: l.d.arrivedBy ?? 'other',
      bailOut: l.d.bailOut ?? null,
      overdue: l.d.overdue === true,
      suppressed: l.d.suppressed ?? 0,
    }));
}

/** n, median, min and max of the logged dwells (s), and the counts by kind, reason, leave and route. */
export function summarizeStays(stays) {
  const dwell = stays.map((s) => s.dwellS).filter((d) => typeof d === 'number' && Number.isFinite(d)).sort((a, b) => a - b);
  const out = {
    n: dwell.length,
    medianS: dwell.length ? dwell[Math.floor(dwell.length / 2)] : null,
    minS: dwell.length ? dwell[0] : null,
    maxS: dwell.length ? dwell[dwell.length - 1] : null,
    byKind: {},
    byReason: {},
    byLeave: {},
    byArrivedBy: {},
    overdue: stays.filter((s) => s.overdue).length,
    suppressedByRateLimit: stays.reduce((a, s) => a + s.suppressed, 0),
  };
  for (const s of stays) {
    count(out.byKind, s.kind);
    count(out.byReason, s.reason);
    if (s.leave) count(out.byLeave, s.leave);
    count(out.byArrivedBy, s.arrivedBy);
  }
  return out;
}
