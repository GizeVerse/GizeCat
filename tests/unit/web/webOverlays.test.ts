// The web host's in-page overlay (src/web/webOverlays.ts): render mapping onto the viewport and the
// hit-region rules of the desktop overlay manager (freshness, movement, renderer heartbeat).
import { describe, expect, it } from 'vitest';
import type { CatRenderState, HitRegion } from '../../../src/shared/cat';
import type { OverlayConfig } from '../../../src/shared/ipc';
import { defaultSettings, type Settings } from '../../../src/shared/settings';
import type { SimOutput } from '../../../src/shared/sim';
import { createWebDisplayService, WEB_DISPLAY_ID } from '../../../src/web/display';
import { createWebOverlays, HIT_REGION_FRESH_MS } from '../../../src/web/webOverlays';
import { manualTime, memoryLogger } from './helpers';

function output(over: Partial<SimOutput> = {}): SimOutput {
  const x = over.x ?? 300;
  const y = over.y ?? 700;
  return {
    x,
    y,
    facing: 1,
    state: 'idle',
    clip: 'stand',
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0.2,
    contentment: 0.6,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    snap: false,
    displayId: WEB_DISPLAY_ID,
    support: { kind: 'floor', displayId: WEB_DISPLAY_ID },
    boundsPx: { x: x - 42, y: y - 64, width: 84, height: 64 },
    nextTickMs: 33,
    requests: [],
    ...over,
  };
}

function setup(opts: { blocked?: () => boolean } = {}) {
  const time = manualTime(5000);
  const log = memoryLogger();
  let settings: Settings = defaultSettings();
  const display = createWebDisplayService({ viewport: () => ({ width: 1280, height: 720 }), listen: () => () => undefined, timers: time.timers });
  let gone = 0;
  const overlays = createWebOverlays({
    display,
    getSettings: () => settings,
    clock: time.now,
    logger: log,
    onCatGone: () => gone++,
    ...(opts.blocked ? { blocked: opts.blocked } : {}),
  });
  const frames: CatRenderState[] = [];
  const configs: OverlayConfig[] = [];
  overlays.api.onRender((s) => frames.push(s));
  overlays.api.onConfig((c) => configs.push(c));
  return {
    time,
    log,
    overlays,
    frames,
    configs,
    get gone() {
      return gone;
    },
    set settings(s: Settings) {
      settings = s;
    },
    report(region: HitRegion) {
      overlays.api.sendHitRegion(region);
    },
  };
}

describe('web overlays: rendering', () => {
  it('waits for the renderer: nothing before ready, then the config and the current frame as a snap', () => {
    const h = setup();
    h.overlays.render(output(), 100, false);
    expect(h.frames).toEqual([]);
    h.overlays.api.ready();
    expect(h.configs).toEqual([{ displayId: WEB_DISPLAY_ID, scaleFactor: 1, debug: false }]);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ x: 300, y: 700, visible: true, snap: true });
  });

  it('maps world px one to one (the viewport is the world), snaps after a display change only', () => {
    const h = setup();
    h.overlays.api.ready();
    h.overlays.render(output({ x: 410.5, y: 690 }), 100, false);
    h.overlays.render(output({ x: 420, y: 690 }), 133, false);
    expect(h.frames.map((f) => [f.x, f.y, f.snap])).toEqual([
      [410.5, 690, true],
      [420, 690, false],
    ]);
    h.overlays.onDisplayChanged();
    h.overlays.render(output({ x: 425, y: 690 }), 166, false);
    expect(h.frames.at(-1)?.snap).toBe(true);
    expect(h.configs).toHaveLength(2);
  });

  it('sends one final hidden frame when the cat leaves, tells the router, and takes no pointer then', () => {
    const h = setup();
    h.overlays.api.ready();
    h.overlays.render(output(), 100, false);
    expect(h.overlays.hitTest({ x: 300, y: 680 })).toBe(true);
    h.overlays.render(output(), 133, true);
    h.overlays.render(output(), 166, true);
    expect(h.frames.map((f) => f.visible)).toEqual([true, false]);
    expect(h.gone).toBe(1);
    expect(h.overlays.active).toBe(false);
    expect(h.overlays.hitTest({ x: 300, y: 680 })).toBe(false);
    expect(h.overlays.isCursorOverCat({ x: 300, y: 680 })).toBe(false);
  });

  it('plays a sound cue only while sound is on, and each cue once', () => {
    const h = setup();
    h.overlays.api.ready();
    h.overlays.render(output({ sound: { kind: 'meow', at: 90 } }), 100, false);
    expect(h.frames.at(-1)?.sound).toBeUndefined();
    const s = defaultSettings();
    s.sound.enabled = true;
    h.settings = s;
    h.overlays.render(output({ sound: { kind: 'chirp', at: 120 } }), 133, false);
    h.overlays.render(output({ sound: { kind: 'chirp', at: 120 } }), 166, false);
    expect(h.frames.slice(-2).map((f) => f.sound?.kind ?? null)).toEqual(['chirp', null]);
  });
});

describe('web overlays: hit regions (overlayManager rules)', () => {
  it('uses the sim bounds until the renderer reports, then the reported rects', () => {
    const h = setup();
    h.overlays.api.ready();
    h.overlays.render(output(), 100, false);
    // Inside the bounds, before any report.
    expect(h.overlays.hitTest({ x: 262, y: 640 })).toBe(true);
    h.report({ rects: [{ x: 280, y: 650, width: 40, height: 40 }] });
    expect(h.overlays.effectiveRegion().rects).toEqual([{ x: 280, y: 650, width: 40, height: 40 }]);
    expect(h.overlays.hitTest({ x: 290, y: 660 })).toBe(true);
    expect(h.overlays.hitTest({ x: 262, y: 640 })).toBe(false);
    expect(h.overlays.hitTest({ x: 600, y: 100 })).toBe(false);
  });

  it('trusts a reported region while fresh or while the cat has not moved; a moved cat falls back to its bounds', () => {
    const h = setup();
    h.overlays.api.ready();
    h.overlays.render(output({ x: 300 }), 100, false);
    h.report({ rects: [{ x: 280, y: 650, width: 40, height: 40 }] });
    h.time.advance(HIT_REGION_FRESH_MS - 100);
    h.overlays.render(output({ x: 330 }), 133, false);
    expect(h.overlays.effectiveRegion().rects).toEqual([{ x: 280, y: 650, width: 40, height: 40 }]);
    h.time.advance(200);
    expect(h.overlays.effectiveRegion().rects).toEqual([output({ x: 330 }).boundsPx]);
    // A cat that stays put keeps its reported region past the freshness window.
    h.report({ rects: [{ x: 310, y: 650, width: 40, height: 40 }] });
    h.time.advance(1000);
    expect(h.overlays.effectiveRegion().rects).toEqual([{ x: 310, y: 650, width: 40, height: 40 }]);
  });

  it('a renderer that stops reporting (no heartbeat) ages out of interactivity; the sim still sees the cursor on the cat', () => {
    const h = setup();
    h.overlays.api.ready();
    h.overlays.render(output(), 100, false);
    h.report({ rects: [{ x: 280, y: 650, width: 40, height: 40 }] });
    h.time.advance(1400);
    expect(h.overlays.hitTest({ x: 290, y: 660 })).toBe(true);
    h.time.advance(200);
    expect(h.overlays.hitTest({ x: 290, y: 660 })).toBe(false);
    expect(h.overlays.isCursorOverCat({ x: 290, y: 660 })).toBe(true);
  });

  it('takes no pointer before the renderer is ready or while blocked', () => {
    let blocked = false;
    const h = setup({ blocked: () => blocked });
    h.overlays.render(output(), 100, false);
    expect(h.overlays.hitTest({ x: 300, y: 680 })).toBe(false);
    h.overlays.api.ready();
    expect(h.overlays.hitTest({ x: 300, y: 680 })).toBe(true);
    blocked = true;
    expect(h.overlays.hitTest({ x: 300, y: 680 })).toBe(false);
    expect(h.overlays.isCursorOverCat({ x: 300, y: 680 })).toBe(true);
  });

  it('rejects malformed hit regions (zod) and keeps the last good one', () => {
    const h = setup();
    h.overlays.api.ready();
    h.overlays.render(output(), 100, false);
    h.report({ rects: [{ x: 280, y: 650, width: 40, height: 40 }] });
    const bad: unknown[] = [
      { rects: [{ x: Number.NaN, y: 0, width: 1, height: 1 }] },
      { rects: Array.from({ length: 9 }, () => ({ x: 0, y: 0, width: 1, height: 1 })) },
      { rects: [], extra: true },
      null,
    ];
    for (const b of bad) h.overlays.api.sendHitRegion(b as HitRegion);
    expect(h.overlays.debug().rejectedHitReports).toBe(4);
    expect(h.overlays.effectiveRegion().rects).toEqual([{ x: 280, y: 650, width: 40, height: 40 }]);
  });

  it('reflects the router (pressed, dragging) and keeps interactivity as bookkeeping', () => {
    const h = setup();
    h.overlays.api.ready();
    h.overlays.render(output(), 100, false);
    const input = { pressed: false, dragging: false };
    h.overlays.bindInput(input);
    h.overlays.updateInteractivity({ x: 300, y: 680 }, false);
    expect(h.overlays.interactive).toBe(true);
    h.overlays.updateInteractivity({ x: 900, y: 100 }, false);
    expect(h.overlays.interactive).toBe(false);
    input.pressed = true;
    input.dragging = true;
    expect([h.overlays.pressed, h.overlays.dragging]).toEqual([true, true]);
    h.overlays.updateInteractivity({ x: 900, y: 100 }, false);
    expect(h.overlays.interactive).toBe(true);
  });

  it('logs renderer errors a bounded number of times', () => {
    const h = setup();
    for (let i = 0; i < 50; i++) h.overlays.api.reportError(`frame failed ${i}`);
    expect(h.overlays.debug().rendererErrors).toBe(50);
    expect(h.log.entries.filter((e) => e.level === 'warn')).toHaveLength(20);
  });
});
