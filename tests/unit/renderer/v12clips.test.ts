// v1.2 (ADR 0003 §8): the 14 authored clips, the jumpKind / impact / balance hints, the crouch
// wiggle from 0 s, the gaits against GAIT_LIMIT_DIP and the strike poses' hit regions against
// HIT_FRONT_EXTENT_DIP, measured on the real rig.
import { describe, expect, it } from 'vitest';
import {
  ANIM_CLIPS,
  CAT_BASE_WIDTH_DIP,
  GAIT_LIMIT_DIP,
  HIT_FRONT_EXTENT_DIP,
  JUMP_KINDS,
  type AnimClip,
  type CatRenderState,
  type GaitClip,
  type StrikePose,
} from '../../../src/shared/cat';
import {
  CLIP_BASE,
  clipDurationS,
  CROUCH_WIGGLE_RAMP_S,
  GAIT_CLEAN_LIMIT_DIP,
  gaitHz,
  isGait,
  loopPeriodS,
  sampleClip,
  SLIP_EDGE_X,
  type ClipContext,
} from '../../../src/renderer/overlay/cat/clips';
import { frameIntervalMs, FULL_RATE_MS, type FrameMotion } from '../../../src/renderer/overlay/frameRate';
import { createPose, LEG_POSE_KEYS, POSE_KEYS, type Pose } from '../../../src/renderer/overlay/cat/pose';
import { applyMatX, applyMatY, Rig } from '../../../src/renderer/overlay/cat/rig';
import { CatScene } from '../../../src/renderer/overlay/scene';

// The 14 clips of v1.2: those between 'climb' and the Living Companion clips (scratch, shake, confused),
// which livingCompanion.test.ts covers.
const V12_CLIPS = ANIM_CLIPS.slice(ANIM_CLIPS.indexOf('climb') + 1, ANIM_CLIPS.indexOf('scratch'));
/** The placeholders the contract step (C1) gave the new clips; each must now be drawn differently. */
const C1_PLACEHOLDER: Readonly<Record<string, AnimClip>> = {
  stalk: 'walk',
  sprint: 'run',
  pounce: 'jump',
  slip: 'fall',
  impact: 'land',
  landRecover: 'sit',
  swat: 'pawAt',
  hiss: 'startle',
  grumpy: 'annoyed',
  slink: 'walk',
  stretch: 'wake',
  balance: 'stand',
  tailChase: 'rollOver',
  edgeSit: 'sit',
};

const ctx = (t: number, extra: Partial<ClipContext> = {}): ClipContext => ({
  t,
  cycle: t * 1.5,
  speed: 0.6,
  vy: 0,
  lookX: 40,
  lookY: -30,
  hasLook: true,
  arousal: 0.4,
  contentment: 0.5,
  ...extra,
});

const pose = (clip: AnimClip, t: number, extra: Partial<ClipContext> = {}): Pose => sampleClip(clip, ctx(t, extra), createPose());

function poseDiff(a: Pose, b: Pose): number {
  let d = 0;
  for (const k of POSE_KEYS) d = Math.max(d, Math.abs(a[k] - b[k]));
  return d;
}

/** Highest torso outline point below which nothing of the body is (ground clearance of the belly, DIP). */
function bellyClearance(p: Pose): number {
  const rig = new Rig();
  rig.solve(p);
  let maxY = -Infinity;
  for (let i = 1; i < rig.torso.length; i += 2) maxY = Math.max(maxY, rig.torso[i]!);
  return -maxY;
}

describe('v1.2 clips are authored', () => {
  it('no clip borrows a placeholder any more, and each one differs from the pose it borrowed', () => {
    expect(Object.keys(CLIP_BASE)).toEqual([]);
    expect(V12_CLIPS.length).toBe(14);
    for (const clip of V12_CLIPS) {
      const base = C1_PLACEHOLDER[clip]!;
      let worst = 0;
      for (const t of [0.1, 0.3, 0.6, 1.1, 1.7]) {
        const extra: Partial<ClipContext> = { vy: clip === 'pounce' ? 300 : 0 };
        worst = Math.max(worst, poseDiff(pose(clip, t, extra), pose(base, t, extra)));
      }
      expect(worst, `${clip} vs its placeholder ${base}`).toBeGreaterThan(2);
    }
  });

  it('new gaits are gaits and pace with speed; new loops report their period', () => {
    for (const clip of ['stalk', 'slink', 'sprint'] as const) {
      expect(isGait(clip), clip).toBe(true);
      expect(gaitHz(clip, 0.2), clip).toBeLessThanOrEqual(gaitHz(clip, 2));
      expect(gaitHz(clip, 0.2), clip).toBeGreaterThan(0);
    }
    for (const clip of ['grumpy', 'tailChase', 'edgeSit'] as const) expect(loopPeriodS(clip), clip).toBeGreaterThan(0);
    for (const clip of ['pounce', 'balance', 'grumpy', 'tailChase', 'edgeSit']) expect(isGait(clip as AnimClip), clip).toBe(false);
  });

  it('stalk: belly ~30 % lower than the walk, head level and forward, tail low and straight', () => {
    for (const t of [1, 1.2, 1.4]) {
      const stalk = pose('stalk', t, { speed: 24 / CAT_BASE_WIDTH_DIP });
      const walk = pose('walk', t, { speed: 24 / CAT_BASE_WIDTH_DIP });
      expect(bellyClearance(stalk)).toBeLessThan(0.78 * bellyClearance(walk));
      expect(stalk.headY).toBeGreaterThan(walk.headY + 6);
      expect(stalk.headX).toBeGreaterThan(walk.headX);
      expect(stalk.tailBase).toBeLessThan(0.1);
      expect(stalk.earFR, 'ears forward').toBeLessThan(0);
    }
  });

  it('sprint: a longer extension than the run, ears back, tail straight out', () => {
    let sprintMax = 0;
    let runMax = 0;
    for (let i = 0; i < 40; i++) {
      const c = i / 40;
      sprintMax = Math.max(sprintMax, sampleClip('sprint', ctx(1, { cycle: c, speed: 4 }), createPose()).bodyLen);
      runMax = Math.max(runMax, sampleClip('run', ctx(1, { cycle: c, speed: 4 }), createPose()).bodyLen);
    }
    expect(sprintMax).toBeGreaterThan(runMax + 0.03);
    const p = pose('sprint', 1, { speed: 4 });
    expect(p.earBR).toBeGreaterThan(0.6);
    expect(Math.abs(p.tailBase)).toBeLessThan(0.15);
    expect(p.tailStiff).toBeGreaterThan(0.8);
  });

  it('slink: low, ears back and flat, tail low', () => {
    const p = pose('slink', 1, { speed: 1 });
    const walk = pose('walk', 1, { speed: 1 });
    expect(bellyClearance(p)).toBeLessThan(0.85 * bellyClearance(walk));
    expect(p.earBR).toBeGreaterThan(0.4);
    expect(p.earBF).toBeGreaterThan(0.3);
    expect(p.tailBase).toBeLessThan(-0.2);
  });

  it('pounce: forelegs reach forward, hind legs trail, ears forward, and the body follows vy', () => {
    const up = pose('pounce', 0.3, { vy: -400 });
    const down = pose('pounce', 0.3, { vy: 400 });
    for (const p of [up, down]) {
      expect(p.fnX).toBeGreaterThan(22);
      expect(p.bnX).toBeLessThan(-25);
      expect(p.earFR).toBeLessThan(0);
    }
    expect(up.tilt).toBeGreaterThan(down.tilt + 0.3);
    expect(down.fnY, 'reaching down onto the prey').toBeGreaterThan(up.fnY + 10);
    // jump/fall with jumpKind 'pounce' play the same pose.
    expect(poseDiff(pose('jump', 0.3, { vy: 400, jumpKind: 'pounce' }), down)).toBeLessThan(1e-9);
    expect(poseDiff(pose('fall', 0.3, { vy: 400, jumpKind: 'pounce' }), down)).toBeLessThan(1e-9);
  });

  it('slip: front paws hooked on the ledge edge, body hanging below it, hind legs paddling, then up and standing', () => {
    const hangA = pose('slip', 0.3);
    const hangB = pose('slip', 0.42);
    for (const p of [hangA, hangB]) {
      expect(p.bodyY, 'body below the ledge').toBeGreaterThan(0);
      expect(p.bodyX, 'body beyond the edge').toBeLessThan(SLIP_EDGE_X);
      expect(Math.abs(p.fnY + 1), 'front paw on the ledge').toBeLessThan(0.01);
      expect(p.fnX, 'front paw on the ledge').toBeGreaterThan(SLIP_EDGE_X);
      expect(p.bnY, 'hind paws below the ledge').toBeGreaterThan(15);
    }
    expect(Math.abs(hangA.bnX - hangB.bnX) + Math.abs(hangA.bnY - hangB.bnY), 'paddling').toBeGreaterThan(1);
    expect(poseDiff(pose('slip', clipDurationS('slip')!), createPose()), 'ends in the standing pose').toBeLessThan(1e-9);
  });

  it('impact: a deeper squash than a landing, deeper with a harder impact, legs splayed', () => {
    const peak = (clip: AnimClip, impact?: number): number => {
      let sq = 1;
      for (let t = 0; t < 0.3; t += 0.005) sq = Math.min(sq, pose(clip, t, impact === undefined ? {} : { impact }).sqY);
      return sq;
    };
    expect(peak('impact')).toBeLessThan(peak('land') - 0.03);
    expect(peak('impact', 1)).toBeLessThan(peak('impact', 0) - 0.08);
    const p = pose('impact', 0.3, { impact: 1 });
    expect(p.fnX - p.bfX).toBeGreaterThan(pose('stand', 0).fnX - pose('stand', 0).bfX + 5);
  });

  it('landRecover: shakes its head, looks around, and ends sitting', () => {
    let shake = 0;
    for (let t = 0.1; t < 0.35; t += 0.01) shake = Math.max(shake, Math.abs(pose('landRecover', t).headRot - pose('landRecover', 0.02).headRot));
    expect(shake).toBeGreaterThan(0.1);
    expect(Math.min(pose('landRecover', 0.52).faceTurn, pose('landRecover', 0.7).faceTurn)).toBeLessThan(-1);
    expect(poseDiff(pose('landRecover', 0.9, { lookX: 0, lookY: 0, hasLook: false }), pose('sit', 0))).toBeLessThan(0.3);
  });

  it('swat: weight back, one forepaw strikes forward toward the look point and comes back down', () => {
    const rest = pose('swat', 0);
    const strike = pose('swat', 0.21, { lookX: 70, lookY: -30 });
    expect(strike.fnX).toBeGreaterThan(rest.fnX + 12);
    expect(strike.fnY).toBeLessThan(-8);
    expect(strike.bodyX).toBeLessThan(rest.bodyX - 1.5);
    expect(strike.tilt).toBeGreaterThan(rest.tilt + 0.05);
    const end = pose('swat', clipDurationS('swat')!);
    expect(Math.abs(end.fnY)).toBeLessThan(0.05);
  });

  it('hiss: arched back, puffed tail, ears flat, mouth open', () => {
    const p = pose('hiss', 0.5);
    expect(p.arch).toBeGreaterThan(1);
    expect(p.tailPuff).toBeGreaterThan(0.95);
    expect(p.tailBase).toBeGreaterThan(1.3);
    expect(Math.min(p.earBF, p.earFF)).toBeGreaterThan(0.9);
    expect(p.mouthOpen).toBeGreaterThan(0.8);
  });

  it('grumpy: low sit, ears out, narrowed eyes, the tail thumps', () => {
    const p = pose('grumpy', 1);
    const sit = pose('sit', 1);
    expect(p.bodyY).toBeGreaterThan(sit.bodyY);
    expect(p.eyeOpen).toBeLessThan(0.65);
    expect(p.earBF).toBeGreaterThan(0.4);
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < loopPeriodS('grumpy')!; t += 0.02) {
      const b = pose('grumpy', t).tailBase;
      lo = Math.min(lo, b);
      hi = Math.max(hi, b);
    }
    expect(hi - lo).toBeGreaterThan(0.5);
  });

  it('stretch: a front stretch, a back stretch with a hind leg out, then standing', () => {
    expect(pose('stretch', 0.5).tilt).toBeLessThan(-0.3);
    expect(pose('stretch', 0.5).fnX).toBeGreaterThan(30);
    expect(pose('stretch', 1.1).bnX).toBeLessThan(-25);
    expect(poseDiff(pose('stretch', clipDurationS('stretch')!), createPose()), 'ends in the standing pose').toBeLessThan(1e-9);
  });

  it('balance: crouched with the paws together; the sway grows with the balance hint', () => {
    const sway = (balance: number | undefined): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = 0; t < 4; t += 0.02) {
        const r = pose('balance', t, balance === undefined ? {} : { balance }).rot;
        lo = Math.min(lo, r);
        hi = Math.max(hi, r);
      }
      return hi - lo;
    };
    expect(sway(1)).toBeGreaterThan(3 * sway(0));
    expect(sway(undefined)).toBeCloseTo(sway(0), 9);
    const p = pose('balance', 1);
    expect(p.fnX - p.bfX).toBeLessThan(pose('stand', 0).fnX - pose('stand', 0).bfX - 10);
    expect(bellyClearance(p)).toBeLessThan(bellyClearance(pose('stand', 0)));
  });

  it('tailChase: spins on the spot (the pose turns through its mirror image), head after the tail', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0.4; t < 0.4 + loopPeriodS('tailChase')!; t += 0.01) {
      const p = pose('tailChase', t);
      lo = Math.min(lo, p.turnX);
      hi = Math.max(hi, p.turnX);
      expect(p.faceTurn, 'looking back at the tail').toBeLessThan(-1);
    }
    expect(lo).toBeLessThan(-0.95);
    expect(hi).toBeGreaterThan(0.95);
  });

  it('edgeSit: sits with the paws forward at the edge and the head down', () => {
    const p = pose('edgeSit', 1);
    const sit = pose('sit', 1);
    expect(p.fnX).toBeGreaterThan(sit.fnX + 1);
    expect(p.headX).toBeGreaterThan(sit.headX + 3);
    expect(p.headRot).toBeLessThan(sit.headRot - 0.2);
  });

  it('the fast new clips are drawn at the full frame rate', () => {
    const calm: FrameMotion = { clip: 'stand', state: 'idle', speed: 0, vy: 0, moved: false, transition: false, poseSpeed: 0, quiet: false };
    for (const clip of ['stalk', 'sprint', 'slink', 'pounce', 'slip', 'impact', 'landRecover', 'swat', 'hiss', 'tailChase'] as AnimClip[]) {
      expect(frameIntervalMs({ ...calm, clip }, 1e9), clip).toBe(FULL_RATE_MS);
    }
  });
});

describe('v1.2 render hints in the clips', () => {
  it('jump and fall without a jumpKind play exactly the v1.1 poses; with one, a pose per kind', () => {
    for (const clip of ['jump', 'fall'] as const) {
      for (const vy of [-400, 0, 400]) {
        const v11 = pose(clip, 0.3, { vy });
        expect(poseDiff(pose(clip, 0.3, { vy, jumpKind: null }), v11)).toBe(0);
        const seen: Pose[] = [];
        for (const kind of JUMP_KINDS) {
          const p = pose(clip, 0.3, { vy, jumpKind: kind });
          expect(poseDiff(p, v11), `${clip} ${kind} vy ${vy}`).toBeGreaterThan(2);
          for (const q of seen) expect(poseDiff(p, q), `${clip} ${kind} vy ${vy} is its own pose`).toBeGreaterThan(1);
          seen.push(p);
        }
      }
    }
  });

  it('a planned flight is calm (no startled open mouth), and its fall continues the jump without a pop', () => {
    for (const kind of JUMP_KINDS) {
      for (const vy of [-300, 50, 450]) {
        const j = pose('jump', 0.5, { vy, jumpKind: kind });
        const f = pose('fall', 0.5, { vy, jumpKind: kind });
        expect(poseDiff(j, f), `${kind} vy ${vy}`).toBeLessThan(1e-9);
        expect(f.mouthOpen, kind).toBeLessThan(0.1);
      }
    }
    expect(pose('fall', 0.5, { vy: 450 }).mouthOpen, 'the v1.1 (unplanned) fall still gasps').toBeGreaterThan(0.1);
  });

  it("'up' reaches higher than 'down', which leans nose-first with the hind legs tucked", () => {
    const up = pose('jump', 0.3, { vy: -400, jumpKind: 'up' });
    const down = pose('fall', 0.3, { vy: 300, jumpKind: 'down' });
    expect(up.tilt).toBeGreaterThan(0.4);
    expect(up.headY).toBeLessThan(down.headY - 10);
    expect(down.tilt).toBeLessThan(-0.25);
    expect(down.bnY).toBeLessThan(-5);
    expect(down.fnY).toBeGreaterThan(0);
  });

  it('land: impact 0.5 (and absent) is the default squash; harder is deeper', () => {
    const at = 0.05;
    expect(poseDiff(pose('land', at), pose('land', at, { impact: 0.5 }))).toBe(0);
    expect(pose('land', at, { impact: 1 }).sqY).toBeLessThan(pose('land', at, { impact: 0 }).sqY - 0.05);
    // A broken hint falls back to the default.
    expect(poseDiff(pose('land', at, { impact: Number.NaN }), pose('land', at))).toBe(0);
  });

  it('climb: the balance hint stiffens the tail while clinging and never moves a gripping paw', () => {
    for (const t of [1, 1.5, 2.2]) {
      const still = { speed: 0, engage: 0 };
      const plain = pose('climb', t, still);
      const bal = pose('climb', t, { ...still, balance: 1 });
      expect(poseDiff(pose('climb', t, { ...still, balance: 0 }), plain)).toBe(0);
      expect(bal.tailStiff).toBeGreaterThan(plain.tailStiff + 0.2);
      for (const [kx, ky] of LEG_POSE_KEYS) {
        expect(bal[kx]).toBe(plain[kx]);
        expect(bal[ky]).toBe(plain[ky]);
      }
      // Climbing (fully engaged), the hint does nothing.
      const moving = { speed: 0.5, engage: 1, cycle: t * 2 };
      expect(poseDiff(pose('climb', t, { ...moving, balance: 1 }), pose('climb', t, moving))).toBe(0);
    }
  });

  it('crouch: the butt wiggle starts at once (v1.1 waited 0.35 s, longer than the old pounce crouch)', () => {
    let tread = 0;
    let sway = 0;
    const settle = pose('crouch', 0);
    for (let t = 0.02; t <= 0.3; t += 0.01) {
      const p = pose('crouch', t);
      tread = Math.max(tread, Math.abs(p.bnY), Math.abs(p.bfY));
      sway = Math.max(sway, Math.abs(p.bodyX - settle.bodyX));
    }
    expect(CROUCH_WIGGLE_RAMP_S).toBeLessThanOrEqual(0.2);
    expect(tread).toBeGreaterThan(0.8);
    expect(sway).toBeGreaterThan(0.5);
  });
});

describe('gaits against GAIT_LIMIT_DIP (ADR 0003 §6.7)', () => {
  const GROUND_GAITS: GaitClip[] = ['walk', 'run', 'stalk', 'slink', 'sprint'];

  it('each locomotion clip is authored to at least its published limit', () => {
    for (const clip of Object.keys(GAIT_LIMIT_DIP) as GaitClip[]) {
      // run is 393.7 against 394 (the v1.1 value, rounded in diagnosis §4): well inside 0.5 %.
      expect(GAIT_CLEAN_LIMIT_DIP[clip], clip).toBeGreaterThanOrEqual(GAIT_LIMIT_DIP[clip] * 0.995);
    }
  });

  /**
   * Worst drift of a planted paw against the ground while the anchor moves at `v` DIP/s, as a share
   * of the anchor's travel: from the pose targets, and (`rig`) from the drawn rig's solved paws.
   */
  function drift(clip: AnimClip, v: number, rig: boolean): { worst: number; samples: number } {
    const speed = v / CAT_BASE_WIDTH_DIP;
    const hz = gaitHz(clip, speed);
    const p = createPose();
    const r = new Rig();
    const prevX = [0, 0, 0, 0];
    const prevY = [1, 1, 1, 1];
    let worst = 0;
    let samples = 0;
    const dt = 1 / 480;
    for (let i = 0; i <= 480; i++) {
      const t = 1 + i * dt;
      sampleClip(clip, ctx(t, { cycle: hz * t, speed, hasLook: false }), p);
      r.solve(p);
      for (let k = 0; k < 4; k++) {
        const [kx, ky] = LEG_POSE_KEYS[k]!;
        const x = rig ? r.legs[k]!.fx : p[kx];
        const planted = p[ky] === 0;
        if (i > 0 && planted && prevY[k] === 0) {
          samples++;
          worst = Math.max(worst, Math.abs(x - prevX[k]! + v * dt) / (v * dt));
        }
        prevX[k] = x;
        prevY[k] = planted ? 0 : 1;
      }
    }
    return { worst, samples };
  }

  it('planted paws stay put up to the limit (pose targets, every ground gait)', () => {
    for (const clip of GROUND_GAITS) {
      for (const frac of [0.3, 0.6, 1]) {
        const d = drift(clip, GAIT_LIMIT_DIP[clip] * frac, false);
        expect(d.samples, clip).toBeGreaterThan(300);
        expect(d.worst, `${clip} at ${frac} x limit`).toBeLessThan(0.005);
      }
    }
  });

  it('the new gaits keep the drawn paws planted too (the v1.1 run cannot: its stride outreaches its legs)', () => {
    for (const clip of ['stalk', 'slink', 'sprint', 'walk'] as const) {
      for (const frac of [0.3, 0.6, 1]) {
        const d = drift(clip, GAIT_LIMIT_DIP[clip] * frac, true);
        expect(d.worst, `${clip} at ${frac} x limit`).toBeLessThan(0.01);
      }
    }
    expect(drift('run', 300, true).worst, 'documents the v1.1 run').toBeGreaterThan(0.2);
  });

  it('the cadence stays bounded at any speed', () => {
    for (const clip of GROUND_GAITS) {
      for (const s of [0, -1, Number.NaN, 1e6]) {
        expect(Number.isFinite(gaitHz(clip, s)), clip).toBe(true);
        expect(gaitHz(clip, s), clip).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe('strike poses: hit region vs HIT_FRONT_EXTENT_DIP (ADR 0003 §4.2, §6.5)', () => {
  function state(clip: AnimClip, t: number, over: Partial<CatRenderState>): CatRenderState {
    return {
      seq: Math.round(t),
      t,
      x: 600,
      y: 500,
      snap: false,
      scale: 1,
      facing: 1,
      state: 'idle',
      clip,
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
      skin: 'ginger',
      style: 'smooth',
      shadow: true,
      animSpeed: 1,
      ...over,
    };
  }

  /** How far (DIP at size 1) the hit region reaches ahead of the anchor in the facing direction, at worst. */
  function frontExtent(clip: AnimClip, pose: StrikePose, over: Partial<CatRenderState>): { dip: number; where: string } {
    const facing = over.facing ?? 1;
    const size = over.scale ?? 1;
    // The cursor (look target) anywhere the cat might watch it while striking: ahead, above, below.
    const looks: Array<{ dx: number; dy: number } | null> = [null];
    for (const dx of [10, 30, 60, 120, 250]) for (const dy of [-200, -80, -30, 0, 15, 40]) looks.push({ dx, dy });
    let dip = 0;
    let where = '';
    const dur = clipDurationS(clip);
    const end = dur === null ? 2000 : dur * 1000 + 300;
    for (const look of looks) {
      const scene = new CatScene(() => 0.99);
      const dt = 1000 / 60;
      for (let t = 0; t <= end; t += dt) {
        const vy = clip === 'jump' || clip === 'fall' || clip === 'pounce' ? (t < end / 2 ? -450 : 450) * size : 0;
        const lk = look ? { x: 600 + facing * look.dx * size, y: 500 + look.dy * size } : null;
        const s = state(clip, t, { ...over, look: lk, vy });
        scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : dt, snapped: t === 0 });
        for (let i = 0; i < scene.hitCount; i++) {
          const r = scene.hitRects[i]!;
          const ahead = (facing > 0 ? r.x + r.width - 600 : 600 - r.x) / size;
          if (ahead > dip) {
            dip = ahead;
            where = `${pose} ${clip} ${JSON.stringify(over)} look ${JSON.stringify(look)} t=${t.toFixed(0)} rect ${i}`;
          }
        }
      }
    }
    return { dip, where };
  }

  const CASES: Array<[StrikePose, AnimClip, Partial<CatRenderState>]> = [
    ['crouch', 'crouch', {}],
    ['pounce', 'pounce', {}],
    ['pounce', 'jump', { jumpKind: 'pounce' }],
    ['pounce', 'fall', { jumpKind: 'pounce' }],
    ['land', 'land', {}],
    ['land', 'land', { impact: 0 }],
    ['land', 'land', { impact: 1 }],
    ['pawAt', 'pawAt', {}],
    ['swat', 'swat', {}],
  ];

  it('never reaches further ahead of the anchor than published, in both styles, facings and sizes', () => {
    const failures: string[] = [];
    const worst: Partial<Record<StrikePose, number>> = {};
    for (const [key, clip, hints] of CASES) {
      for (const style of ['smooth', 'pixel'] as const) {
        for (const facing of [1, -1] as const) {
          for (const scale of [1, 2.5]) {
            const r = frontExtent(clip, key, { ...hints, style, facing, scale });
            worst[key] = Math.max(worst[key] ?? 0, r.dip);
            if (r.dip > HIT_FRONT_EXTENT_DIP[key]) failures.push(`${r.where}: ${r.dip.toFixed(2)} > ${HIT_FRONT_EXTENT_DIP[key]}`);
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    // The bounds are not vacuous: each pose reaches most of the way to its bound.
    for (const key of Object.keys(HIT_FRONT_EXTENT_DIP) as StrikePose[]) expect(worst[key], key).toBeGreaterThan(25);
  }, 120_000);
});

describe('emote clamp and head hit region (ADR 0003 §8.2)', () => {
  function scene(clip: AnimClip, x: number, y: number, over: Partial<CatRenderState> = {}): CatScene {
    const sc = new CatScene(() => 0.99);
    const dt = 1000 / 60;
    for (let t = 0; t <= 1500; t += dt) {
      const s: CatRenderState = {
        seq: Math.round(t),
        t,
        x,
        y,
        snap: false,
        scale: 1,
        facing: 1,
        state: 'idle',
        clip,
        clipStartedAt: 0,
        speed: 0,
        vy: 0,
        look: null,
        arousal: 0.3,
        contentment: 0.5,
        emote: 'heart',
        emoteStartedAt: 1000,
        opacity: 1,
        visible: true,
        skin: 'ginger',
        style: 'smooth',
        shadow: true,
        animSpeed: 1,
        ...over,
      };
      sc.update({ x, y, state: s, simTime: t, dtMs: t === 0 ? 0 : dt, snapped: t === 0 });
    }
    return sc;
  }

  it('keeps the whole emote inside the overlay when the cat is at its top', () => {
    for (const clip of ['sit', 'stand', 'climb'] as AnimClip[]) {
      for (const scale of [1, 2]) {
        for (const y of [30, 60, 90, 120, 160, 200]) {
          // The emote never takes the drawn bounds above the overlay's top edge (y = 0); the cat may.
          const plain = scene(clip, 400, y, { scale, emote: null });
          const s = scene(clip, 400, y, { scale });
          expect(s.bounds.y, `${clip} size ${scale} at y ${y}`).toBeGreaterThanOrEqual(Math.min(0, plain.bounds.y) - 1e-9);
        }
      }
    }
    // Lower down nothing changes: the emote floats above the head as before.
    const low = scene('sit', 400, 400);
    expect(low.bounds.y).toBeLessThan(low.hitRects[0]!.y - 20);
  });

  it('never pulls an emote into an overlay the cat is above (a display seam)', () => {
    expect(scene('sit', 400, -30).bounds.y).toBeLessThan(-60);
  });

  it('the head hit rect still covers the whole drawn head, whatever way it turns', () => {
    for (const look of [null, { x: 460, y: 330 }, { x: 460, y: 150 }, { x: 300, y: 250 }]) {
      for (const clip of ['stand', 'sit', 'crouch', 'hiss', 'grumpy', 'edgeSit'] as AnimClip[]) {
        const s = scene(clip, 400, 300, { look, emote: null });
        const r = s.hitRects[0]!;
        const rig = s.puppet.rig;
        const c = Math.cos(rig.headRot);
        const sn = Math.sin(rig.headRot);
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * 2 * Math.PI;
          // The drawn head outline (draw.ts HEAD_SHAPE reaches about 17.6 x 13.6 DIP from its centre).
          const lx = 17.2 * Math.cos(a);
          const ly = 13.2 * Math.sin(a);
          const hx = rig.headX + lx * c + ly * sn;
          const hy = rig.headY - lx * sn + ly * c;
          const px = 400 + applyMatX(rig.m, hx, hy);
          const py = 300 + applyMatY(rig.m, hx, hy);
          const inside = px >= r.x - 1e-6 && px <= r.x + r.width + 1e-6 && py >= r.y - 1e-6 && py <= r.y + r.height + 1e-6;
          expect(inside, `${clip} look ${JSON.stringify(look)} point ${i}`).toBe(true);
        }
      }
    }
  });
});
