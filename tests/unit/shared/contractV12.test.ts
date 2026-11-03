// v1.2 contract step (ADR 0003 §13): the shared types, the settings v3 schema and migration, the
// presets, the opt-out lists, the behaviour-profile records, the landing impact classes, the UIA
// protocol-2 additions and the allow-list. Behaviour is unchanged in this step; these tests pin
// the contract every implementation package codes against.
import { describe, expect, it } from 'vitest';
import { BEHAVIOR_STATES, type BehaviorState } from '../../../src/shared/cat';
import { ACTIVITY_CLASS, emptyBehaviorProfile, MAX_RECENT_STAYS, quantiles, type ExcursionRecord } from '../../../src/shared/behaviorProfile';
import {
  applySettingsPatch,
  defaultSettings,
  disabledBehaviorSet,
  LIVELY_BEHAVIORS,
  migrateSettings,
  SETTINGS_SCHEMA_VERSION,
  SettingsSchema,
  TOGGLEABLE_BEHAVIORS,
} from '../../../src/shared/settings';
import { ACTIVITY_PRESET_IDS, matchingPreset, PRESET_BEHAVIOR_KEYS, PRESET_INTERACTION_KEYS, PRESET_VALUES, presetPatch } from '../../../src/shared/settingsPresets';
import { impactClass, impactLevel, MOVEMENT } from '../../../src/core/movement';
import { BehaviorProfileRecorder } from '../../../src/core/behavior/profile';
import { parseHelperLine, stripKind } from '../../../src/main/uia/protocol';
import { TAB_STRIP_APPS, tabStripRuleFor } from '../../../src/main/uia/allowList';
import { mapRenderState, type RenderMapContext } from '../../../src/main/overlay/renderMapping';
import type { SimOutput } from '../../../src/shared/sim';
import type { DecisionRecord, FallRecord } from '../../../src/shared/behaviorProfile';
import { Harness } from '../core/behavior/fixtures';

/** The user's 1.1.1 settings as written by v2 (every key; the deliberate values differ from the defaults). */
function userV2File(): Record<string, unknown> {
  const v2 = JSON.parse(JSON.stringify(defaultSettings())) as Record<string, Record<string, unknown>>;
  delete v2.sound;
  for (const k of ['activityPreset', 'exploration', 'heights', 'mischief', 'workDisruption', 'stayLength', 'disabledExtras']) delete v2.behavior![k];
  delete v2.interaction!.reactionIntensity;
  Object.assign(v2.behavior!, {
    autonomy: 0.8,
    cursorPlay: 0.7,
    attentionSeeking: 0.5,
    activitySensitivity: 0.95,
    sleepAfterIdleMinutes: 30,
    chaseDurationSec: 5,
    disabledBehaviors: ['zoomies', 'taskbarPlay'],
  });
  Object.assign(v2.perception!, { visualMode: 'local-stats', consentAt: '2026-10-28T10:00:00.000Z' });
  return { ...v2, schemaVersion: 2 };
}

describe('settings v3 schema', () => {
  it('is version 3 with every v2 key and default kept, the new keys at the Playful preset and sound off', () => {
    const s = defaultSettings();
    expect(SETTINGS_SCHEMA_VERSION).toBe(3);
    expect(s.schemaVersion).toBe(3);
    // v2 keys and defaults (unchanged).
    expect(s.behavior).toMatchObject({ autonomy: 0.6, cursorPlay: 0.5, attentionSeeking: 0.35, activitySensitivity: 0.6, sleepAfterIdleMinutes: 5, chaseDurationSec: 4.5, disabledBehaviors: [] });
    expect(s.interaction.patience).toBe(0.5);
    // Privacy defaults (pinned in .claude/standard.json) are untouched.
    expect(s.perception.visualMode).toBe('off');
    expect(s.perception.consentAt).toBeNull();
    expect(s.ai.allowCloud).toBe(false);
    // New keys.
    expect(s.behavior.activityPreset).toBe('playful');
    expect(matchingPreset(s)).toBe('playful');
    expect(s.behavior.disabledExtras).toEqual([]);
    expect(s.sound).toEqual({ enabled: false, volume: 0.4 });
    expect([...TOGGLEABLE_BEHAVIORS]).toHaveLength(10);
  });

  it('migrates v2 -> v3 keeping every explicit value, never raising mischief or work disruption, and marks the user custom', () => {
    const raw = userV2File();
    const m = migrateSettings(raw);
    expect(m.schemaVersion).toBe(3);
    expect(m.behavior).toMatchObject({ autonomy: 0.8, cursorPlay: 0.7, attentionSeeking: 0.5, activitySensitivity: 0.95, sleepAfterIdleMinutes: 30, chaseDurationSec: 5 });
    expect(m.behavior.disabledBehaviors).toEqual(['zoomies', 'taskbarPlay']);
    expect(m.behavior.disabledExtras).toEqual([]);
    expect(m.behavior.activityPreset).toBe('custom');
    expect(m.behavior.mischief).toBe(PRESET_VALUES.playful.behavior.mischief);
    expect(m.behavior.workDisruption).toBe(PRESET_VALUES.playful.behavior.workDisruption);
    // Consent, privacy, AI and login item: exactly what a v2 parse gives.
    const v2parse = SettingsSchema.parse({ ...raw, schemaVersion: 3 });
    expect(m.perception).toEqual(v2parse.perception);
    expect(m.ai).toEqual(v2parse.ai);
    expect(m.loginItem).toEqual(v2parse.loginItem);
    expect(m.perception.consentAt).toBe('2026-10-28T10:00:00.000Z');
  });

  it('is pure and idempotent: the same v2 file twice, and the saved v3 result, give the same settings', () => {
    const raw = userV2File();
    const frozen = JSON.stringify(raw);
    const a = migrateSettings(raw);
    expect(JSON.stringify(raw)).toBe(frozen);
    expect(migrateSettings(raw)).toEqual(a);
    expect(migrateSettings(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });

  it('a v2 file holding the v2 defaults lands on Playful', () => {
    const raw = { ...userV2File(), behavior: { ...defaultSettings().behavior } } as Record<string, unknown>;
    for (const k of ['activityPreset', 'exploration', 'heights', 'mischief', 'workDisruption', 'stayLength', 'disabledExtras']) delete (raw.behavior as Record<string, unknown>)[k];
    expect(migrateSettings(raw).behavior.activityPreset).toBe('playful');
  });

  it('keeps the new opt-out list tolerant: bad entries are dropped one by one, unknown well-formed ids kept', () => {
    const s = SettingsSchema.parse({ behavior: { disabledExtras: ['pounce', 42, 'pounce', 'Bad Id', 'futureThing', null] } });
    expect(s.behavior.disabledExtras).toEqual(['pounce', 'futureThing']);
    expect(SettingsSchema.parse({ behavior: { disabledExtras: 'pounce' } }).behavior.disabledExtras).toEqual([]);
    // The strict v2 list is never touched by the new ids (a downgrade keeps the user's opt-outs).
    const both = SettingsSchema.parse({ behavior: { disabledBehaviors: ['zoomies'], disabledExtras: ['screenEdges'] } });
    expect(both.behavior.disabledBehaviors).toEqual(['zoomies']);
    expect(SettingsSchema.parse({ behavior: { disabledBehaviors: ['zoomies', 'stalkCursor'] } }).behavior.disabledBehaviors).toEqual([]);
  });

  it('a v2 opt-out implies the new behaviours under it; unknown extras are ignored', () => {
    const off = disabledBehaviorSet({ disabledBehaviors: ['chaseCursor', 'tabStrips', 'climbWindows'], disabledExtras: ['futureThing', 'tailChase'] });
    for (const id of ['chaseCursor', 'pounce', 'tabStrips', 'explorerTabs', 'terminalTabs', 'tabReactions', 'climbWindows', 'screenEdges', 'tailChase'] as const) expect(off.has(id), id).toBe(true);
    expect(off.has('slips')).toBe(false);
    expect([...off].every((id) => (TOGGLEABLE_BEHAVIORS as readonly string[]).includes(id) || (LIVELY_BEHAVIORS as readonly string[]).includes(id))).toBe(true);
  });

  it('patches: a preset applies atomically and touches only its keys; a malformed opt-out patch is rejected', () => {
    const cur = defaultSettings();
    for (const id of ACTIVITY_PRESET_IDS) {
      const r = applySettingsPatch(cur, presetPatch(id));
      expect(r.ok, id).toBe(true);
      if (!r.ok) continue;
      expect(matchingPreset(r.settings)).toBe(id);
      expect(r.settings.behavior.activityPreset).toBe(id);
      expect(r.settings.perception).toEqual(cur.perception);
      expect(r.settings.ai).toEqual(cur.ai);
      expect(r.settings.sound).toEqual(cur.sound);
      const changed = Object.keys(r.settings.behavior).filter((k) => JSON.stringify((r.settings.behavior as Record<string, unknown>)[k]) !== JSON.stringify((cur.behavior as Record<string, unknown>)[k]));
      expect(changed.every((k) => (PRESET_BEHAVIOR_KEYS as readonly string[]).includes(k) || k === 'activityPreset'), `${id}: ${changed.join(',')}`).toBe(true);
    }
    expect(Object.keys(presetPatch('calm').interaction)).toEqual([...PRESET_INTERACTION_KEYS]);
    expect(applySettingsPatch(cur, { behavior: { disabledExtras: ['pounce', 'pounce'] } }).ok).toBe(false);
    expect(applySettingsPatch(cur, { behavior: { disabledExtras: ['pounce'] } }).ok).toBe(true);
    expect(applySettingsPatch(cur, { sound: { volume: 2 } }).ok).toBe(false);
  });
});

describe('behaviour profile contract', () => {
  it('classifies every behaviour state', () => {
    expect(Object.keys(ACTIVITY_CLASS).sort()).toEqual([...BEHAVIOR_STATES].sort());
  });

  it('quantiles are nearest-rank and empty-safe', () => {
    expect(quantiles([])).toEqual({ n: 0, p10: 0, p50: 0, p90: 0, max: 0 });
    const q = quantiles([5, 1, 3, 2, 4, 6, 7, 8, 9, 10, Number.NaN]);
    expect(q).toEqual({ n: 10, p10: 1, p50: 5, p90: 9, max: 10 });
  });

  it('the recorder accounts time by class, stays, falls and bounds its history', () => {
    const r = new BehaviorProfileRecorder(0);
    const add = (s: BehaviorState, ms: number): void => r.addTime(s, ms);
    add('idle', 6000);
    add('walking', 3000);
    add('sleeping', 5000);
    add('playing', -10);
    add('playing', Number.NaN);
    const end = (dwellMs: number): ExcursionRecord => ({ phase: 'end', at: dwellMs, surfaceKind: 'tabStrip', arrivedBy: 'climb', plannedMs: 0, dwellMs, endReason: 'leave', leaveKind: 'climbDown' });
    r.excursion({ ...end(0), phase: 'arrive', endReason: null, leaveKind: null });
    for (let i = 1; i <= MAX_RECENT_STAYS + 5; i++) r.excursion(end(i * 1000));
    r.fall({ at: 1, cause: 'slip', heightDip: 120, impact: 'medium', jumpKind: null });
    r.slip({ at: 1, kind: 'miss', risk: 0.5 });
    r.addContext('typing', 500);
    r.addContext('cursorInReach', Number.NaN);
    const s = r.snapshot(42);
    expect(s.context).toEqual({ typing: 500, foregroundMaximized: 0, cursorInReach: 0 });
    expect(s.at).toBe(42);
    expect(s.timeMs).toMatchObject({ calm: 6000, active: 3000, asleep: 5000 });
    expect(s.activeShare).toBeCloseTo(3000 / 9000, 9);
    expect(s.excursions.arrivals).toBe(1);
    expect(s.excursions.byKind).toEqual({ tabStrip: 1 });
    expect(s.excursions.byLeave.climbDown).toBe(MAX_RECENT_STAYS + 5);
    expect(s.excursions.dwellS.n).toBe(MAX_RECENT_STAYS + 5);
    expect(s.recentStays).toHaveLength(MAX_RECENT_STAYS);
    expect(s.falls).toEqual({ count: 1, byCause: { slip: 1 }, byImpact: { medium: 1 } });
    expect(s.slips).toBe(1);
    // Snapshots are copies.
    s.timeMs.calm = 0;
    expect(r.snapshot(43).timeMs.calm).toBe(6000);
    expect(emptyBehaviorProfile(Number.NaN).since).toBe(0);
  });

  it('the sim exposes the profile and calls the new hooks (decisions, falls after a throw)', () => {
    const decisions: DecisionRecord[] = [];
    const falls: FallRecord[] = [];
    const h = new Harness({ seed: 3, hooks: { onDecision: (d) => decisions.push(d), onFall: (f) => falls.push(f) } });
    h.run(90_000);
    h.step([{ type: 'pointer.dragStart', at: { x: h.last!.x, y: h.last!.y - 30 } }]);
    h.env.dragCursor = { x: 900, y: 300 };
    h.step();
    h.step([{ type: 'pointer.dragEnd', at: { x: 900, y: 300 }, velocity: { x: 2500, y: -1500 } }]);
    h.env.dragCursor = null;
    h.run(10_000);
    const p = h.sim.behaviorProfile();
    const total = Object.values(p.timeMs).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(95_000);
    expect(total).toBeLessThan(105_000);
    expect(decisions.length).toBeGreaterThan(0);
    expect(p.decisions).toBe(decisions.length);
    // BEH switched the rhythm on (ADR 0003 §1.6): decisions carry the episode they were taken in.
    expect(decisions.every((d) => d.cause === 'autonomous' && (d.episode === 'active' || d.episode === 'calm'))).toBe(true);
    expect(falls.map((f) => f.cause)).toContain('thrown');
    expect(p.falls.byCause.thrown).toBeGreaterThanOrEqual(1);
  });
});

describe('movement contract', () => {
  it('classifies landing impact by vertical speed', () => {
    expect(impactClass(0)).toBe('soft');
    expect(impactClass(MOVEMENT.impactSoftBelowDip - 1)).toBe('soft');
    expect(impactClass(MOVEMENT.impactSoftBelowDip)).toBe('medium');
    expect(impactClass(-MOVEMENT.impactHardFromDip)).toBe('hard');
    expect(impactClass(Number.NaN)).toBe('soft');
    expect(impactLevel(1e9)).toBe(1);
    expect(impactLevel(Number.NaN)).toBe(0);
  });
});

describe('UIA protocol 2 and the tab-strip allow-list', () => {
  const strip = {
    frame: { x: 0, y: 0, w: 1000, h: 700 },
    work: null,
    dpi: 120,
    container: null,
    tabs: [],
    count: 0,
    leftButton: null,
    newTab: null,
    grab: null,
    captions: null,
    maximized: false,
    vertical: false,
    path: 'class',
    ms: 1,
  };

  it('a protocol-1 strip (no kind) is Chromium; tabview parses; an unknown kind is dropped', () => {
    const v1 = parseHelperLine(JSON.stringify({ id: 1, ok: true, strip }));
    expect(v1?.kind).toBe('response');
    if (v1?.kind === 'response' && v1.response.ok) expect(stripKind(v1.response.strip!)).toBe('chromium');
    const v2 = parseHelperLine(JSON.stringify({ id: 2, ok: true, strip: { ...strip, kind: 'tabview' } }));
    if (v2?.kind === 'response' && v2.response.ok) expect(stripKind(v2.response.strip!)).toBe('tabview');
    else throw new Error('tabview strip did not parse');
    expect(parseHelperLine(JSON.stringify({ id: 3, ok: true, strip: { ...strip, kind: 'gecko' } }))).toBeNull();
    const ping = parseHelperLine(JSON.stringify({ id: 4, ok: true, pong: true, version: 2, kinds: ['chromium', 'tabview'] }));
    expect(ping?.kind).toBe('response');
  });

  it('only allow-listed, enabled, not opted-out apps are ever queried', () => {
    const none = new Set<string>();
    expect(tabStripRuleFor('msedge.exe', none)?.kind).toBe('chromium');
    expect(tabStripRuleFor('CHROME.EXE', none)?.kind).toBe('chromium');
    expect(tabStripRuleFor('chrome.exe', new Set(['tabStrips']))).toBeNull();
    // The protocol-2 helper ships the TabView reader: Terminal is on, Explorer stays behind its soak gate.
    expect(tabStripRuleFor('explorer.exe', none)).toBeNull();
    expect(tabStripRuleFor('windowsterminal.exe', none)?.kind).toBe('tabview');
    for (const exe of ['firefox.exe', 'code.exe', 'notepad.exe', 'obsidian.exe']) expect(tabStripRuleFor(exe, none), exe).toBeNull();
    expect(TAB_STRIP_APPS.every((r) => r.optOuts.includes('tabStrips'))).toBe(true);
  });
});

describe('render mapping of the v1.2 hints', () => {
  const out = (over: Partial<SimOutput> = {}): SimOutput => ({
    x: 400,
    y: 600,
    facing: 1,
    state: 'jumping',
    clip: 'jump',
    clipStartedAt: 10,
    speed: 0,
    vy: -300,
    look: null,
    arousal: 0.4,
    contentment: 0.7,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    snap: false,
    displayId: '1',
    support: { kind: 'air' },
    boundsPx: { x: 360, y: 540, width: 84, height: 64 },
    nextTickMs: 33,
    requests: [],
    ...over,
  });
  const ctx = (over: Partial<RenderMapContext> = {}): RenderMapContext => ({ seq: 1, toLocalDip: (p) => p, scaleFactor: 1, forceSnap: false, hidden: false, simNow: 100, ...over });

  it('a v1.1.1 output maps without any new key; hints are copied and clamped; sound only to the owning overlay', () => {
    const plain = mapRenderState(out(), defaultSettings().appearance, ctx());
    for (const k of ['jumpKind', 'impact', 'balance', 'sound']) expect(plain, k).not.toHaveProperty(k);
    const rich = out({ jumpKind: 'pounce', impact: 3, balance: 0.25, sound: { kind: 'chirp', at: 90 } });
    const a = mapRenderState(rich, defaultSettings().appearance, ctx());
    expect(a).toMatchObject({ jumpKind: 'pounce', impact: 1, balance: 0.25 });
    expect(a).not.toHaveProperty('sound');
    expect(mapRenderState(rich, defaultSettings().appearance, ctx({ soundOwner: true })).sound).toEqual({ kind: 'chirp', at: 90 });
    expect(mapRenderState(rich, defaultSettings().appearance, ctx({ soundOwner: true, soundVolume: 7 })).sound).toEqual({ kind: 'chirp', at: 90, volume: 1 });
  });
});
