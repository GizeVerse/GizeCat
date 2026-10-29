// The v1.1 'climb' clip: clinging to a vertical window edge (anchor = hind-paw grip on the wall
// line, wall on the side the cat faces) and climbing it. Gripping paws stay put on the wall, starting
// and stopping never pops, a climb down runs the gait backwards, the tail hangs (or rests on the
// floor the cat climbed from), and the drawn cat, its hit region, emote, dirty rect and presence
// rect all follow the vertical pose.
import { describe, expect, it } from 'vitest';
import { CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP, type AnimClip, type CatRenderState, type Emote, type RenderStyle } from '../../../src/shared/cat';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimOutput } from '../../../src/shared/sim';
import { presenceRectPx } from '../../../src/main/overlay/renderMapping';
import { CatAnimator, type AnimInput } from '../../../src/renderer/overlay/cat/animator';
import {
  CLIMB_FADE_MS,
  CLIMB_IDLE_PERIOD_S,
  CLIMB_MAX_GRIP_SPEED,
  crossFadeMs,
  gaitHz,
  loopPeriodS,
  sampleClip,
  type ClipContext,
} from '../../../src/renderer/overlay/cat/clips';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { copyPose, createPose, POSE_KEYS, type Pose, type PoseKey } from '../../../src/renderer/overlay/cat/pose';
import { CatPuppet } from '../../../src/renderer/overlay/cat/puppet';
import { applyMatX, applyMatY, PAW_RX } from '../../../src/renderer/overlay/cat/rig';
import { TAIL_RADIUS_TIP } from '../../../src/renderer/overlay/cat/tail';
import { CatScene, type DeviceRect, type Layer } from '../../../src/renderer/overlay/scene';
import { boxInside, createExtentCtx, emptyBox, type Box } from './extentCtx';

const DT = 1000 / 60;
const BL = CAT_BASE_WIDTH_DIP;
const FEET: readonly (readonly [PoseKey, PoseKey])[] = [
  ['fnX', 'fnY'],
  ['ffX', 'ffY'],
  ['bnX', 'bnY'],
  ['bfX', 'bfY'],
];

const ctxAt = (t: number, cycle: number, speed: number): ClipContext => ({
  t,
  cycle,
  speed,
  vy: 0,
  lookX: 0,
  lookY: 0,
  hasLook: false,
  arousal: 0.3,
  contentment: 0.5,
});

const input = (clip: AnimClip, clipStartedAt: number, speed: number): AnimInput => ({
  clip,
  clipStartedAt,
  sleeping: false,
  speed,
  vy: 0,
  lookX: 0,
  lookY: 0,
  hasLook: false,
  arousal: 0.3,
  contentment: 0.5,
  animSpeed: 1,
});

function state(t: number, extra: Partial<CatRenderState> = {}): CatRenderState {
  return {
    seq: Math.round(t),
    t,
    x: 400,
    y: 300,
    snap: false,
    scale: 1,
    facing: 1,
    state: 'idle',
    clip: 'climb',
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
    ...extra,
  };
}

/** Runs a scene on the wall for `ms`, the anchor climbing at `speed` (body lengths/s, negative = down). */
function climbScene(ms: number, speed: number, extra: Partial<CatRenderState> = {}): CatScene {
  const scene = new CatScene(() => 0.99);
  const scale = extra.scale ?? 1;
  for (let t = 0; t <= ms; t += DT) {
    const y = 300 - speed * BL * scale * (t / 1000);
    const s = state(t, { y, speed: Math.abs(speed), ...extra });
    scene.update({ x: s.x, y, state: s, simTime: t, dtMs: t === 0 ? 0 : DT, snapped: t === 0 });
  }
  return scene;
}

describe('climb clip: gait on the wall', () => {
  it('a gripping paw stays put on the wall while the anchor climbs, up or down', () => {
    const p = createPose();
    const prev = createPose();
    expect(CLIMB_MAX_GRIP_SPEED).toBeGreaterThan(0.7);
    for (const speed of [0.2, 0.5, CLIMB_MAX_GRIP_SPEED]) {
      for (const dir of [1, -1]) {
        const hz = gaitHz('climb', speed);
        const v = speed * BL;
        let gripSamples = 0;
        let worst = 0;
        let lastAnchor = 0;
        for (let i = 0; i <= 240; i++) {
          const t = 1 + i / 240;
          // Anchor height (cat-local DIP, up = -y) and gait cycle, as the animator integrates them.
          const anchor = -dir * v * t;
          sampleClip('climb', ctxAt(t, dir * hz * t, speed), p);
          if (i > 0) {
            for (const [kx, ky] of FEET) {
              // Gripping: the paw is on the wall line (not swung out) in both samples.
              if (Math.abs(p[kx] - prev[kx]) > 1e-9) continue;
              gripSamples++;
              worst = Math.max(worst, Math.abs(anchor + p[ky] - (lastAnchor + prev[ky])));
            }
          }
          copyPose(prev, p);
          lastAnchor = anchor;
        }
        expect(gripSamples, `speed ${speed} dir ${dir}`).toBeGreaterThan(300);
        // Each paw's world height changes only by float noise while it grips (samples are ~4 ms apart).
        expect(worst, `speed ${speed} dir ${dir}`).toBeLessThan(1e-6);
      }
    }
  });

  it('the cadence follows the speed and stays bounded', () => {
    expect(gaitHz('climb', 0.3)).toBeLessThan(gaitHz('climb', 0.6));
    for (const s of [0, -1, Number.NaN, 1e6]) {
      expect(Number.isFinite(gaitHz('climb', s))).toBe(true);
      expect(gaitHz('climb', s)).toBeGreaterThan(0);
      expect(gaitHz('climb', s)).toBeLessThanOrEqual(2.6);
    }
  });

  it('holding still the paws stay on their grips and the idle repeats with its period', () => {
    expect(loopPeriodS('climb')).toBe(CLIMB_IDLE_PERIOD_S);
    const a = createPose();
    const b = createPose();
    for (const t of [0.4, 1.7, 2.6, 4.0, 5.5, 6.9]) {
      // The gait cycle keeps running at speed 0 but has no stride: only the idle may move a paw.
      sampleClip('climb', ctxAt(t, 0, 0), a);
      sampleClip('climb', ctxAt(t, 0.37 + t, 0), b);
      for (const k of POSE_KEYS) expect(b[k], `t=${t} ${k}`).toBeCloseTo(a[k], 9);
      sampleClip('climb', ctxAt(t + CLIMB_IDLE_PERIOD_S, 0, 0), b);
      for (const k of POSE_KEYS) expect(b[k], `t=${t} ${k} periodic`).toBeCloseTo(a[k], 9);
    }
    // Only the short re-grip lifts the near front paw, and only a little.
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < CLIMB_IDLE_PERIOD_S; t += 0.02) {
      sampleClip('climb', ctxAt(t, 0, 0), a);
      lo = Math.min(lo, a.fnY);
      hi = Math.max(hi, a.fnY);
      expect(a.bnY, `hind paw @${t}`).toBeCloseTo(-1, 9);
    }
    expect(hi - lo).toBeGreaterThan(1);
    expect(hi - lo).toBeLessThan(3);
  });

  it('starting, stopping and changing speed on the wall never pops', () => {
    const anim = new CatAnimator(() => 0.99);
    const prev = createPose();
    const speeds = [0, 0.5, 0, 0.7, 0.2, 0, 0.6];
    let worst = 0;
    let worstKey = '';
    let t = 0;
    for (const speed of speeds) {
      for (let i = 0; i < 90; i++, t += DT) {
        const p = anim.update(input('climb', 0, speed), t, DT, 0, -speed * BL * (DT / 1000));
        if (t > 0) {
          for (const k of ['bodyX', 'bodyY', 'headX', 'headY', 'fnX', 'fnY', 'ffX', 'ffY', 'bnX', 'bnY', 'bfX', 'bfY'] as PoseKey[]) {
            const d = Math.abs(anim.base[k] - prev[k]);
            if (d > worst) {
              worst = d;
              worstKey = `${k} @${Math.round(t)}`;
            }
          }
        }
        copyPose(prev, anim.base);
        expect(Number.isFinite(p.fnY)).toBe(true);
      }
    }
    // A paw reaching up the wall at 1.2 body lengths/s moves ~3 DIP per frame; a pop would be the full stride (10).
    expect(worst, worstKey).toBeLessThan(4);
  });

  it('a climb down runs the gait backwards so the gripping paws keep their hold', () => {
    const anim = new CatAnimator(() => 0.99);
    const speed = 0.5;
    const step = speed * BL * (DT / 1000);
    let anchor = 0;
    const prev = createPose();
    let grip = 0;
    let worst = 0;
    for (let i = 0, t = 0; i < 240; i++, t += DT) {
      // Down the wall: the anchor moves down (+y) by `step` every frame.
      anim.update(input('climb', 0, speed), t, DT, 0, i === 0 ? 0 : step);
      if (i > 0) anchor += step;
      // After the gait direction has settled (a few frames of smoothing) and the eased speed has converged.
      if (i > 60 && Math.abs(anim.base.bnX - prev.bnX) < 1e-9) {
        grip++;
        worst = Math.max(worst, Math.abs(anchor + anim.base.bnY - (anchor - step + prev.bnY)));
      }
      copyPose(prev, anim.base);
    }
    expect(grip).toBeGreaterThan(60);
    expect(worst).toBeLessThan(0.05);
  });
});

describe('climb clip: transitions', () => {
  it('uses longer fades on and off the wall, and the held fade when picked up', () => {
    for (const c of ['walk', 'stand', 'crouch', 'sit'] as AnimClip[]) {
      expect(crossFadeMs(c, 'climb'), c).toBe(CLIMB_FADE_MS);
      expect(crossFadeMs('climb', c), c).toBe(CLIMB_FADE_MS);
    }
    expect(crossFadeMs('climb', 'held')).toBe(crossFadeMs('stand', 'held'));
    for (const c of ['jump', 'fall', 'land', 'startle'] as AnimClip[]) {
      expect(crossFadeMs('climb', c), c).toBeGreaterThan(crossFadeMs('stand', c));
    }
    expect(crossFadeMs('jump', 'climb')).toBeLessThan(CLIMB_FADE_MS);
  });

  it('walking up to a window, climbing it and pulling up onto its top moves every body part smoothly', () => {
    // Anchor path like the sim's: walk to the wall, step onto the wall line within one tick, climb,
    // hold, then rise onto the ledge and step in over the pull-up fade.
    const wallX = 400;
    const floor = 500;
    const top = 380;
    type Leg = { clip: AnimClip; ms: number; x: number; y: number; speed: number };
    const legs: Leg[] = [
      { clip: 'walk', ms: 900, x: wallX - 14, y: floor, speed: 0.7 },
      { clip: 'climb', ms: 33, x: wallX, y: floor, speed: 0.5 },
      { clip: 'climb', ms: 1700, x: wallX, y: top + 60, speed: 0.5 },
      { clip: 'climb', ms: 600, x: wallX, y: top + 60, speed: 0 },
      { clip: 'stand', ms: CLIMB_FADE_MS * 0.55, x: wallX + 6, y: top, speed: 0 },
      { clip: 'stand', ms: CLIMB_FADE_MS * 0.45, x: wallX + 18, y: top, speed: 0 },
      { clip: 'stand', ms: 800, x: wallX + 18, y: top, speed: 0 },
    ];
    const scene = new CatScene(() => 0.99);
    let x = wallX - 74;
    let y = floor;
    let t = 0;
    let clip: AnimClip = 'walk';
    let clipStart = 0;
    const prev = new Float64Array(12);
    let worst = 0;
    let worstAt = '';
    let frame = 0;
    for (const leg of legs) {
      const x0 = x;
      const y0 = y;
      if (leg.clip !== clip) {
        clip = leg.clip;
        clipStart = t;
      }
      for (let lt = 0; lt < leg.ms; lt += DT, t += DT, frame++) {
        const k = Math.min(1, lt / leg.ms);
        x = x0 + (leg.x - x0) * k;
        y = y0 + (leg.y - y0) * k;
        const s = state(t, { x, y, clip, clipStartedAt: clipStart, speed: leg.speed });
        scene.update({ x, y, state: s, simTime: t, dtMs: frame === 0 ? 0 : DT, snapped: frame === 0 });
        const rig = scene.puppet.rig;
        const tail = scene.puppet.tail;
        const pts = [
          [rig.headX, rig.headY],
          [rig.bodyX, rig.bodyY],
          ...rig.legs.map((g) => [g.fx, g.fy]),
          [tail.x[tail.count - 1]!, tail.y[tail.count - 1]!],
        ];
        pts.forEach(([px, py], i) => {
          const X = x + applyMatX(rig.m, px!, py!);
          const Y = y + applyMatY(rig.m, px!, py!);
          if (frame > 0) {
            const d = Math.hypot(X - prev[i * 2]!, Y - prev[i * 2 + 1]!);
            if (d > worst) {
              worst = d;
              worstAt = `${clip} point ${i} t=${Math.round(t)}`;
            }
          }
          prev[i * 2] = X;
          prev[i * 2 + 1] = Y;
        });
      }
    }
    // The pull-up lifts the cat ~60 DIP and turns it 90 degrees in 280 ms; a pop would be tens of DIP in one frame.
    expect(worst, worstAt).toBeLessThan(12);
  });
});

describe('climb clip: tail', () => {
  /** Puppet on the floor (walking), then on the wall climbing `climbDip` up, returns the tail's lowest point per frame. */
  function climbFromFloor(climbDip: number, speed: number): { lows: number[]; puppet: CatPuppet; t: number } {
    const puppet = new CatPuppet(() => 0.99);
    let t = 0;
    for (; t < 1500; t += DT) puppet.advance(input('walk', 0, 0.7), t, DT, 0.7 * BL * (DT / 1000), 0);
    const start = t;
    const step = speed * BL * (DT / 1000);
    const lows: number[] = [];
    let climbed = 0;
    // Ground line relative to the anchor while climbing: it falls away as the cat climbs.
    for (; climbed < climbDip; t += DT) {
      puppet.advance(input('climb', start, speed), t, DT, 0, -step);
      climbed += step;
      let low = -Infinity;
      for (let i = 1; i < puppet.tail.count; i++) low = Math.max(low, puppet.tail.y[i]! - climbed);
      lows.push(low);
    }
    return { lows, puppet, t };
  }

  it('rests on the floor the cat climbed up from, then hangs below its hind paws', () => {
    const { lows, puppet } = climbFromFloor(90, 0.5);
    // Never below the floor line (world y = 0 here), up to the tail's radius.
    for (const [i, low] of lows.entries()) expect(low, `frame ${i}`).toBeLessThanOrEqual(-TAIL_RADIUS_TIP + 1e-6);
    // Once clear of the floor it hangs well below the anchor (hind-paw grip).
    let lowest = -Infinity;
    for (let i = 1; i < puppet.tail.count; i++) lowest = Math.max(lowest, puppet.tail.y[i]!);
    expect(lowest).toBeGreaterThan(12);
  });

  it('hangs with no ground under it when the cat got onto the wall from the air', () => {
    const puppet = new CatPuppet(() => 0.99);
    let t = 0;
    for (; t < 600; t += DT) puppet.advance(input('jump', 0, 0), t, DT, 0, -3);
    for (const start = t; t < start + 1500; t += DT) puppet.advance(input('climb', start, 0), t, DT, 0, 0);
    let lowest = -Infinity;
    for (let i = 1; i < puppet.tail.count; i++) lowest = Math.max(lowest, puppet.tail.y[i]!);
    expect(lowest).toBeGreaterThan(12);
  });

  it('eases onto the ledge after pulling up, without a jump', () => {
    for (const climbDip of [20, 120]) {
      const { puppet, t: end } = climbFromFloor(climbDip, 0.5);
      let t = end;
      const px = Float64Array.from(puppet.tail.y);
      let worst = 0;
      for (const start = t; t < start + 1200; t += DT) {
        puppet.advance(input('stand', start, 0), t, DT, 0, 0);
        for (let i = 1; i < puppet.tail.count; i++) {
          worst = Math.max(worst, Math.abs(puppet.tail.y[i]! - px[i]!));
          px[i] = puppet.tail.y[i]!;
        }
      }
      for (let i = 1; i < puppet.tail.count; i++) expect(puppet.tail.y[i]!, `${climbDip}: point ${i}`).toBeLessThanOrEqual(-TAIL_RADIUS_TIP + 1e-6);
      expect(worst, `${climbDip}`).toBeLessThan(6);
    }
  });
});

describe('climb clip: drawn geometry', () => {
  it('extends about a body length up the wall, on the cat side of the wall line, mirrored with facing', () => {
    for (const facing of [1, -1] as const) {
      for (const speed of [0, 0.5]) {
        const scene = climbScene(2500, speed, { facing });
        const b = scene.bounds;
        const y = 300 - speed * BL * 2.5;
        // Up: head and ears about a body length above the hind-paw grip.
        expect(y - b.y, `f${facing} v${speed} up`).toBeGreaterThan(CAT_BASE_WIDTH_DIP * 0.95);
        expect(y - b.y, `f${facing} v${speed} up`).toBeLessThan(CAT_BASE_WIDTH_DIP * 1.25);
        // Sideways: the body is on the cat's side of the wall, only paws reach a little past the line.
        const past = facing > 0 ? b.x + b.width - 400 : 400 - b.x;
        const behind = facing > 0 ? 400 - b.x : b.x + b.width - 400;
        expect(past, `f${facing} v${speed} past the wall`).toBeLessThan(PAW_RX + 9);
        expect(behind, `f${facing} v${speed} body side`).toBeGreaterThan(45);
        // The head is up the wall and on the cat's side of it.
        const head = scene.hitRects[0]!;
        expect(head.y + head.height, 'head above the hind paws').toBeLessThan(y - 40);
        expect((head.x + head.width / 2 - 400) * facing, 'head on the cat side').toBeLessThan(0);
      }
    }
  });

  it('hit rects follow the vertical pose: head on top, body and legs along the wall, no tail tip', () => {
    for (const facing of [1, -1] as const) {
      for (const speed of [0, 0.5]) {
        const scene = climbScene(1800, speed, { facing });
        const y = 300 - speed * BL * 1.8;
        expect(scene.hitCount).toBe(4);
        const head = scene.hitRects[0]!;
        const body = scene.hitRects[1]!;
        const legs = scene.hitRects[2]!;
        const tailBase = scene.hitRects[3]!;
        expect(head.y, 'head above the body').toBeLessThan(body.y);
        expect(body.height, 'body upright').toBeGreaterThan(body.width);
        // Legs reach from the hind-paw grip up to the front paws on the wall.
        expect(legs.y + legs.height).toBeGreaterThan(y - 2);
        expect(legs.y).toBeLessThan(y - 55);
        const nearWall = facing > 0 ? legs.x + legs.width : legs.x;
        expect(Math.abs(nearWall - 400)).toBeLessThan(PAW_RX + 6);
        expect(tailBase.height).toBeGreaterThan(2);
        const tail = scene.puppet.tail;
        const tipX = 400 + facing * tail.x[tail.count - 1]!;
        const tipY = y + tail.y[tail.count - 1]!;
        let area = 0;
        const b = scene.bounds;
        for (let i = 0; i < scene.hitCount; i++) {
          const r = scene.hitRects[i]!;
          area += r.width * r.height;
          expect(tipX > r.x && tipX < r.x + r.width && tipY > r.y && tipY < r.y + r.height, `tail tip in rect ${i}`).toBe(false);
          expect(r.x).toBeGreaterThanOrEqual(b.x);
          expect(r.y).toBeGreaterThanOrEqual(b.y);
          expect(r.x + r.width).toBeLessThanOrEqual(b.x + b.width + 1e-6);
          expect(r.y + r.height).toBeLessThanOrEqual(b.y + b.height + 1e-6);
        }
        expect(area).toBeGreaterThan(1500);
        expect(area).toBeLessThan(CAT_BASE_WIDTH_DIP * CAT_BASE_HEIGHT_DIP * 2.5);
      }
    }
  });

  it('puts an emote above the head of the climbing cat', () => {
    for (const facing of [1, -1] as const) {
      const plain = climbScene(1500, 0, { facing });
      const withEmote = climbScene(1500, 0, { facing, emote: 'heart', emoteStartedAt: 1000 });
      const head = plain.hitRects[0]!;
      const b = withEmote.bounds;
      // The emote raises the top of the drawn bounds well above the head and stays near it sideways.
      expect(b.y).toBeLessThan(head.y - 20);
      expect(b.y).toBeGreaterThan(head.y - 60);
      expect(b.x).toBeGreaterThan(plain.bounds.x - 20);
      expect(b.x + b.width).toBeLessThan(plain.bounds.x + plain.bounds.width + 20);
    }
  });
});

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

function simOutput(x: number, y: number, size: number, sf: number): SimOutput {
  const bw = CAT_BASE_WIDTH_DIP * size * sf;
  const bh = CAT_BASE_HEIGHT_DIP * size * sf;
  const ax = x * sf;
  const ay = y * sf;
  return {
    x: ax,
    y: ay,
    facing: 1,
    state: 'idle',
    clip: 'climb',
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
    support: { kind: 'surface', surfaceId: 'windowSide:1:left', surfaceKind: 'windowSide', orientation: 'wall' },
    // The sim's nominal upright footprint above the anchor.
    boundsPx: { x: ax - bw / 2, y: ay - bh, width: bw, height: bh },
    nextTickMs: 33,
    requests: [],
  };
}

describe('climb clip: dirty rect and presence while climbing', () => {
  it('everything painted is inside the dirty rect and the presence rect, climbing up and down', () => {
    const failures: string[] = [];
    const rect: DeviceRect = { x: 0, y: 0, w: 0, h: 0 };
    for (const style of ['smooth', 'pixel'] as RenderStyle[]) {
      for (const emote of [null, 'zzz'] as (Emote | null)[]) {
        for (const size of [0.6, 1, 2.5]) {
          for (const sf of [1, 1.5]) {
            const appearance = { ...defaultSettings().appearance, size, emotes: emote !== null, style };
            for (const facing of [1, -1] as const) {
              for (const speed of [0.5, -0.5, 1.4]) {
                const scene = new CatScene(seededRandom(11));
                for (let t = 0; t <= 2600; t += 40) {
                  const x = 1200;
                  const y = 1500 - speed * BL * size * (t / 1000);
                  const s = state(t, {
                    x,
                    y,
                    facing,
                    scale: size,
                    speed: Math.abs(speed),
                    style,
                    skin: 'black',
                    arousal: 0.9,
                    emote,
                    emoteStartedAt: 100,
                    look: { x: x + 60 * facing, y: y - 60 },
                    reaction: t >= 1200 ? { kind: 'tailFlick', at: 1200 } : null,
                  });
                  scene.update({ x, y, state: s, simTime: t, dtMs: t === 0 ? 0 : 40, snapped: t === 0 });
                  const b = paintedBox(scene, sf);
                  if (!Number.isFinite(b.x0)) continue;
                  const tag = `${style}/${emote}/size${size}/sf${sf}/f${facing}/v${speed} t=${t}`;
                  scene.deviceRect(sf, rect);
                  const px: Box = { x0: Math.floor(b.x0), y0: Math.floor(b.y0), x1: Math.ceil(b.x1), y1: Math.ceil(b.y1) };
                  if (!boxInside(px, rect)) failures.push(`${tag}: painted ${JSON.stringify(px)} outside dirty rect ${JSON.stringify(rect)}`);
                  const p = presenceRectPx(simOutput(x, y, size, sf), appearance, sf);
                  const tol = 1;
                  if (b.x0 < p.x - tol || b.y0 < p.y - tol || b.x1 > p.x + p.width + tol || b.y1 > p.y + p.height + tol) {
                    failures.push(`${tag}: painted ${JSON.stringify(b)} outside presence ${JSON.stringify(p)}`);
                  }
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

describe('climb clip: pose sanity', () => {
  it('keeps the head upright and the shadow off on the wall', () => {
    const p: Pose = createPose();
    for (let t = 0; t < 8; t += 0.1) {
      for (const speed of [0, 0.5]) {
        sampleClip('climb', ctxAt(t, t * gaitHz('climb', speed), speed), p);
        expect(Math.abs(p.headRot), `t=${t}`).toBeLessThan(0.5);
        expect(p.rot).toBe(0);
        expect(p.shadow).toBe(0);
        expect(p.tilt, 'body along the wall').toBeGreaterThan(1.3);
        // Every paw on (or swung just off) the wall line, never inside the window.
        for (const [kx] of FEET) expect(p[kx], `${kx} t=${t}`).toBeLessThanOrEqual(0);
        expect(p.fnY, 'front paws up the wall').toBeLessThan(-45);
      }
    }
  });
});
