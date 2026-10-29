// One-off body-language reactions (CatRenderState.reaction): an ear flick, a tail flick or
// a head tilt layered on whatever clip plays, once per distinct `at`, then back to the
// clip's own pose. Also the snapshot validation of the optional field and the drawn
// extent of reacting poses (dirty rect and the presence margins main uses).
import { describe, expect, it } from 'vitest';
import { ANIM_CLIPS, CAT_REACTIONS, type AnimClip, type CatReaction, type CatReactionKind, type CatRenderState, type RenderStyle } from '../../../src/shared/cat';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimOutput } from '../../../src/shared/sim';
import { presenceRectPx } from '../../../src/main/overlay/renderMapping';
import { CatAnimator, HEAD_TILT_RAD, REACTION_DURATION_S, type AnimInput } from '../../../src/renderer/overlay/cat/animator';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import type { Pose } from '../../../src/renderer/overlay/cat/pose';
import { isPoseFinite } from '../../../src/renderer/overlay/cat/pose';
import { CatPuppet } from '../../../src/renderer/overlay/cat/puppet';
import { CatScene, type DeviceRect, type Layer } from '../../../src/renderer/overlay/scene';
import { isRenderState } from '../../../src/renderer/overlay/validate';
import { boxInside, createExtentCtx, emptyBox, type Box } from './extentCtx';

const DT = 1000 / 60;

const input = (clip: AnimClip, extra: Partial<AnimInput> = {}): AnimInput => ({
  clip,
  clipStartedAt: 0,
  sleeping: clip === 'sleep',
  speed: clip === 'walk' ? 0.7 : clip === 'run' ? 2.5 : clip === 'climb' ? 0.5 : 0,
  vy: 0,
  lookX: 0,
  lookY: 0,
  hasLook: false,
  arousal: 0.3,
  contentment: 0.5,
  animSpeed: 1,
  ...extra,
});

const ears = (p: Pose): number => p.earBR + p.earBF + p.earFR + p.earFF;

interface Sample {
  t: number;
  /** Pose of the reacting animator minus the same animator without the reaction. */
  d: number;
}

/**
 * Runs a reacting animator next to an identical control one (same seed, no reaction)
 * and returns the difference of `key` per frame. The reaction is in every snapshot from
 * the first one at or after its `at`, like the sim's output.
 */
function diffTrace(clip: AnimClip, reactions: readonly CatReaction[], untilMs: number, key: (p: Pose) => number, opts: { seed?: number; dt?: number; animSpeed?: number } = {}): Sample[] {
  const dt = opts.dt ?? DT;
  const a = new CatAnimator(seededRandom(opts.seed ?? 7));
  const b = new CatAnimator(seededRandom(opts.seed ?? 7));
  const out: Sample[] = [];
  for (let t = 0; t < untilMs; t += dt) {
    let current: CatReaction | null = null;
    for (const r of reactions) if (t >= r.at) current = r;
    const extra = { animSpeed: opts.animSpeed ?? 1 };
    const pa = a.update(input(clip, { ...extra, reaction: current }), t, dt, 0);
    const pb = b.update(input(clip, extra), t, dt, 0);
    out.push({ t, d: key(pa) - key(pb) });
  }
  return out;
}

const maxAbs = (s: readonly Sample[]): number => s.reduce((m, x) => Math.max(m, Math.abs(x.d)), 0);
const within = (s: readonly Sample[], t0: number, t1: number): Sample[] => s.filter((x) => x.t >= t0 && x.t < t1);

describe('reaction layers', () => {
  it('earFlick lays an ear back quickly and returns it within ~300 ms', () => {
    const at = 2000;
    const s = diffTrace('sit', [{ kind: 'earFlick', at }], 3000, ears);
    expect(maxAbs(within(s, 0, at))).toBe(0);
    const during = within(s, at, at + 300);
    expect(maxAbs(during)).toBeGreaterThan(0.5);
    const peak = during.reduce((a, b) => (b.d > a.d ? b : a));
    expect(peak.t - at).toBeLessThan(120);
    expect(during.every((x) => x.d >= 0)).toBe(true);
    expect(maxAbs(within(s, at + 300, 3000))).toBe(0);
  });

  it('tailFlick snaps the tail and lets it settle back', () => {
    const at = 2000;
    const a = new CatPuppet(seededRandom(7));
    const b = new CatPuppet(seededRandom(7));
    let peak = 0;
    let late = 0;
    let curl = 0;
    for (let t = 0; t < 4000; t += DT) {
      const reaction: CatReaction | null = t >= at ? { kind: 'tailFlick', at } : null;
      a.advance(input('stand', { reaction }), t, DT, 0, 0);
      b.advance(input('stand'), t, DT, 0, 0);
      const n = a.tail.count - 1;
      const d = Math.hypot(a.tail.x[n]! - b.tail.x[n]!, a.tail.y[n]! - b.tail.y[n]!);
      if (t < at) expect(d).toBe(0);
      else if (t < at + 600) peak = Math.max(peak, d);
      else if (t >= at + 1500) late = Math.max(late, d);
      if (t >= at && t < at + 400) curl = Math.max(curl, Math.abs(a.pose.tailCurl - b.pose.tailCurl));
    }
    expect(curl).toBeGreaterThan(1);
    // A visible snap of the tip (the tail is ~37 DIP long), then back on the clip's tail.
    expect(peak).toBeGreaterThan(6);
    expect(late).toBeLessThan(0.5);
  });

  it('headTilt tilts the head about 12 degrees and returns within ~600 ms', () => {
    const at = 2000;
    const s = diffTrace('sit', [{ kind: 'headTilt', at }], 3000, (p) => p.headRot);
    expect(HEAD_TILT_RAD).toBeCloseTo((12 * Math.PI) / 180, 10);
    const peak = maxAbs(within(s, at, at + 600));
    expect(peak).toBeGreaterThan(HEAD_TILT_RAD * 0.95);
    expect(peak).toBeLessThanOrEqual(HEAD_TILT_RAD + 1e-9);
    // Held in the middle, eased at both ends.
    expect(Math.abs(within(s, at + 250, at + 270)[0]!.d)).toBeGreaterThan(HEAD_TILT_RAD * 0.95);
    expect(Math.abs(within(s, at, at + 20)[0]!.d)).toBeLessThan(HEAD_TILT_RAD * 0.1);
    expect(maxAbs(within(s, at + 600, 3000))).toBe(0);
  });

  it('plays once per distinct `at`, however many snapshots carry it', () => {
    const plays = (s: readonly Sample[]): number => {
      let n = 0;
      let on = false;
      for (const x of s) {
        const now = Math.abs(x.d) > 0.02;
        if (now && !on) n++;
        on = now;
      }
      return n;
    };
    // The same reaction stays in every snapshot for 4 s: one play.
    expect(plays(diffTrace('stand', [{ kind: 'earFlick', at: 1000 }], 5000, ears))).toBe(1);
    // Three distinct ones: three plays.
    const three: CatReaction[] = [
      { kind: 'earFlick', at: 1000 },
      { kind: 'earFlick', at: 2500 },
      { kind: 'earFlick', at: 4000 },
    ];
    expect(plays(diffTrace('stand', three, 5000, ears))).toBe(3);
  });

  it('does not restart a kind that is still playing (no pop back to the start)', () => {
    const s = diffTrace(
      'sit',
      [
        { kind: 'headTilt', at: 1000 },
        { kind: 'headTilt', at: 1250 },
      ],
      2500,
      (p) => p.headRot,
    );
    let worst = 0;
    for (let i = 1; i < s.length; i++) worst = Math.max(worst, Math.abs(s[i]!.d - s[i - 1]!.d));
    expect(worst).toBeLessThan(HEAD_TILT_RAD * 0.25);
    // The second one was swallowed by the first: everything is over 600 ms after the first.
    expect(maxAbs(within(s, 1600, 2500))).toBe(0);
  });

  it('different kinds layer independently', () => {
    const both: CatReaction[] = [
      { kind: 'headTilt', at: 1000 },
      { kind: 'earFlick', at: 1100 },
    ];
    const head = diffTrace('sit', both, 2000, (p) => p.headRot);
    const ear = diffTrace('sit', both, 2000, ears);
    expect(maxAbs(within(head, 1100, 1400))).toBeGreaterThan(HEAD_TILT_RAD * 0.9);
    expect(maxAbs(within(ear, 1100, 1400))).toBeGreaterThan(0.5);
  });

  it('a reaction that started long ago (the cat just entered this overlay) is not replayed', () => {
    const anim = new CatAnimator(seededRandom(3));
    const ctrl = new CatAnimator(seededRandom(3));
    for (let t = 10_000; t < 12_000; t += DT) {
      const a = anim.update(input('sit', { reaction: { kind: 'headTilt', at: 5000 } }), t, DT, 0);
      const b = ctrl.update(input('sit'), t, DT, 0);
      expect(a.headRot).toBe(b.headRot);
    }
    expect(anim.reacting).toBe(false);
  });

  it('is time-based: the same pose at 30 and 60 fps, and slower with a slower animation speed', () => {
    const at = 1000;
    const key = (p: Pose): number => p.headRot;
    const fast = diffTrace('sit', [{ kind: 'headTilt', at }], 2000, key, { dt: 1000 / 60 });
    const slow = diffTrace('sit', [{ kind: 'headTilt', at }], 2000, key, { dt: 1000 / 30 });
    for (const x of slow) {
      const twin = fast.find((f) => Math.abs(f.t - x.t) < 1e-6);
      if (twin) expect(x.d).toBeCloseTo(twin.d, 9);
    }
    const half = diffTrace('sit', [{ kind: 'headTilt', at }], 2600, key, { animSpeed: 0.5 });
    expect(maxAbs(within(half, at + 900, at + 1000))).toBeGreaterThan(0.05);
    expect(maxAbs(within(half, at + 1200, 2600))).toBe(0);
  });

  it('the variant depends only on `at`, so every overlay at a monitor seam shows the same one', () => {
    for (const kind of ['earFlick', 'headTilt'] as const) {
      for (const at of [1000, 1733, 2417]) {
        const key = kind === 'earFlick' ? (p: Pose) => p.earBR * 3 + p.earFR : (p: Pose) => p.headRot;
        const a = diffTrace('stand', [{ kind, at }], at + 700, key, { seed: 1 });
        const b = diffTrace('stand', [{ kind, at }], at + 700, key, { seed: 99 });
        for (let i = 0; i < a.length; i++) expect(a[i]!.d, `${kind}@${at} t=${a[i]!.t}`).toBeCloseTo(b[i]!.d, 9);
      }
    }
  });

  it('layers on every clip, stays finite, keeps ears within reach and ends on the clip pose', () => {
    for (const clip of ANIM_CLIPS) {
      for (const kind of CAT_REACTIONS) {
        const at = 1500;
        const anim = new CatAnimator(seededRandom(5));
        const ctrl = new CatAnimator(seededRandom(5));
        for (let t = 0; t < at + 1000; t += DT) {
          const reaction = t >= at ? { kind, at } : null;
          const p = anim.update(input(clip, { reaction, arousal: 0.9 }), t, DT, 0);
          const c = ctrl.update(input(clip, { arousal: 0.9 }), t, DT, 0);
          expect(isPoseFinite(p), `${clip}/${kind}`).toBe(true);
          for (const [r, f] of [
            ['earBR', 'earBF'],
            ['earFR', 'earFF'],
          ] as const) {
            const back = (q: Pose): number => q[r] + 0.95 * Math.min(1, Math.max(0, q[f]));
            expect(back(p), `${clip}/${kind} ${r}`).toBeLessThanOrEqual(Math.max(1.3, back(c)) + 1e-9);
          }
          if (t >= at + REACTION_DURATION_S[kind] * 1000) expect(p.headRot, `${clip}/${kind}`).toBe(c.headRot);
        }
        expect(anim.reacting).toBe(false);
      }
    }
  });

  it('ignores hostile reaction input', () => {
    const anim = new CatAnimator(seededRandom(2));
    const bad = [
      { kind: 'wink', at: 100 },
      { kind: 'earFlick', at: Number.NaN },
      { kind: 'headTilt', at: Number.POSITIVE_INFINITY },
    ] as unknown as CatReaction[];
    let t = 0;
    for (const reaction of bad) {
      for (let i = 0; i < 30; i++, t += DT) expect(isPoseFinite(anim.update(input('sit', { reaction }), t, DT, 0))).toBe(true);
    }
    expect(anim.reacting).toBe(false);
  });
});

function snapshot(over: Partial<CatRenderState> = {}): CatRenderState {
  return {
    seq: 1,
    t: 100,
    x: 400,
    y: 300,
    snap: false,
    scale: 1,
    facing: 1,
    state: 'idle',
    clip: 'sit',
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0.3,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    skin: 'ginger',
    style: 'smooth',
    shadow: true,
    animSpeed: 1,
    ...over,
  };
}

describe('reaction in render snapshots', () => {
  it('keeps a valid reaction and accepts snapshots without one', () => {
    const s = snapshot({ reaction: { kind: 'tailFlick', at: 90 } });
    expect(isRenderState(s)).toBe(true);
    expect(s.reaction).toEqual({ kind: 'tailFlick', at: 90 });
    expect(isRenderState(snapshot({ reaction: null }))).toBe(true);
    expect(isRenderState(snapshot())).toBe(true);
  });

  it('drops a malformed reaction but keeps the frame', () => {
    const bad: unknown[] = ['earFlick', 5, { kind: 'wink', at: 1 }, { kind: 'earFlick' }, { kind: 'earFlick', at: Number.NaN }, { kind: 'headTilt', at: '5' }, []];
    for (const reaction of bad) {
      const s = { ...snapshot(), reaction } as unknown as CatRenderState;
      expect(isRenderState(s), JSON.stringify(reaction)).toBe(true);
      expect(s.reaction, JSON.stringify(reaction)).toBeNull();
    }
  });

  it('the scene plays the snapshot reaction on the puppet', () => {
    const a = new CatScene(seededRandom(4));
    const b = new CatScene(seededRandom(4));
    let worst = 0;
    for (let t = 0; t < 1600; t += DT) {
      const reaction: CatReaction | null = t >= 1000 ? { kind: 'headTilt', at: 1000 } : null;
      a.update({ x: 400, y: 300, state: snapshot({ t, reaction }), simTime: t, dtMs: t === 0 ? 0 : DT, snapped: t === 0 });
      b.update({ x: 400, y: 300, state: snapshot({ t }), simTime: t, dtMs: t === 0 ? 0 : DT, snapped: t === 0 });
      worst = Math.max(worst, Math.abs(a.puppet.pose.headRot - b.puppet.pose.headRot));
    }
    expect(worst).toBeGreaterThan(HEAD_TILT_RAD * 0.95);
  });
});

const ANCHOR = { x: 1200, y: 900 };

/** Device-space box of what one frame paints (pixel style: whole blocks of painted layer pixels). */
function paintedBox(scene: CatScene, dpr: number): Box {
  const main = createExtentCtx();
  const lay = createExtentCtx();
  const layer: Layer = { canvas: {} as CanvasImageSource, ctx: lay.ctx };
  let lw = 0;
  scene.draw(main.ctx, dpr, (w) => {
    lw = w;
    return layer;
  });
  if (main.images.length === 0) return { ...main.box };
  const img = main.images[0]!;
  const block = (img.x1 - img.x0) / lw;
  const lb = lay.box;
  if (!Number.isFinite(lb.x0)) return emptyBox();
  return {
    x0: img.x0 + Math.floor(lb.x0) * block,
    y0: img.y0 + Math.floor(lb.y0) * block,
    x1: img.x0 + Math.ceil(lb.x1) * block,
    y1: img.y0 + Math.ceil(lb.y1) * block,
  };
}

function simOutput(sf: number): SimOutput {
  const bw = 84 * sf;
  const bh = 64 * sf;
  const ax = ANCHOR.x * sf;
  const ay = ANCHOR.y * sf;
  return {
    x: ax,
    y: ay,
    facing: 1,
    state: 'idle',
    clip: 'stand',
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0.9,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    snap: false,
    displayId: '1',
    support: { kind: 'floor', displayId: '1' },
    boundsPx: { x: ax - bw / 2, y: ay - bh, width: bw, height: bh },
    nextTickMs: 33,
    requests: [],
  };
}

describe('reacting poses stay inside the drawn bounds', () => {
  it('for every clip and kind: inside the dirty rect and the presence rect main uses', () => {
    const failures: string[] = [];
    const rect: DeviceRect = { x: 0, y: 0, w: 0, h: 0 };
    for (const style of ['smooth', 'pixel'] as RenderStyle[]) {
      for (const sf of [1, 1.5]) {
        const appearance = { ...defaultSettings().appearance, size: 1, emotes: false, style };
        const presence = presenceRectPx(simOutput(sf), appearance, sf);
        for (const clip of ANIM_CLIPS) {
          for (const kind of CAT_REACTIONS as readonly CatReactionKind[]) {
            for (const facing of [1, -1] as const) {
              const scene = new CatScene(seededRandom(11));
              const at = 1300;
              for (let t = 0; t <= at + 700; t += t < at ? 100 : 25) {
                const s = snapshot({
                  seq: t,
                  t,
                  x: ANCHOR.x,
                  y: ANCHOR.y,
                  facing,
                  clip,
                  state: clip === 'sleep' ? 'sleeping' : 'idle',
                  speed: clip === 'walk' ? 0.7 : clip === 'run' ? 2.5 : clip === 'climb' ? 0.5 : 0,
                  vy: clip === 'jump' ? -300 : clip === 'fall' ? 300 : 0,
                  look: { x: ANCHOR.x + 60 * facing, y: ANCHOR.y - 60 },
                  arousal: 0.9,
                  skin: 'black',
                  style,
                  reaction: t >= at ? { kind, at } : null,
                });
                scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : t <= at ? 100 : 25, snapped: t === 0 });
                if (t < at) continue;
                const tag = `${style}/sf${sf}/${clip}/${kind}/f${facing} t=${t}`;
                const b = paintedBox(scene, sf);
                scene.deviceRect(sf, rect);
                const px: Box = { x0: Math.floor(b.x0), y0: Math.floor(b.y0), x1: Math.ceil(b.x1), y1: Math.ceil(b.y1) };
                if (!boxInside(px, rect)) failures.push(`${tag}: painted ${JSON.stringify(px)} outside dirty rect ${JSON.stringify(rect)}`);
                const tol = 1;
                const p = presence;
                if (b.x0 < p.x - tol || b.y0 < p.y - tol || b.x1 > p.x + p.width + tol || b.y1 > p.y + p.height + tol) {
                  failures.push(`${tag}: painted ${JSON.stringify(b)} outside presence ${JSON.stringify(p)}`);
                }
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 120_000);
});
