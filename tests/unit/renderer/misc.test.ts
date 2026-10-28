import { describe, expect, it } from 'vitest';
import type { CatRenderState } from '../../../src/shared/cat';
import { EMOTE_DURATION_MS, emoteFrame, type EmoteFrame } from '../../../src/renderer/overlay/cat/emotes';
import { attachPointerInput, toPointerEvent } from '../../../src/renderer/overlay/input';
import type { OverlayPointerEvent } from '../../../src/shared/ipc';
import { OverlayPointerEventSchema } from '../../../src/shared/ipc';
import { isOverlayConfig, isRenderState } from '../../../src/renderer/overlay/validate';

const valid: CatRenderState = {
  seq: 1,
  t: 100,
  x: 10,
  y: 20,
  snap: false,
  scale: 1,
  facing: -1,
  state: 'idle',
  clip: 'sit',
  clipStartedAt: 0,
  speed: 0,
  vy: 0,
  look: { x: 1, y: 2 },
  arousal: 0,
  contentment: 1,
  emote: 'heart',
  emoteStartedAt: 0,
  opacity: 1,
  visible: true,
  skin: 'calico',
  style: 'pixel',
  shadow: false,
  animSpeed: 1.2,
};

describe('render state validation', () => {
  it('accepts a well-formed snapshot', () => {
    expect(isRenderState(valid)).toBe(true);
    expect(isRenderState({ ...valid, look: null, emote: null })).toBe(true);
  });

  it('rejects malformed snapshots', () => {
    const bad: unknown[] = [
      null,
      42,
      { ...valid, x: Number.NaN },
      { ...valid, facing: 0 },
      { ...valid, clip: 'dance' },
      { ...valid, state: 'flying' },
      { ...valid, skin: 'zebra' },
      { ...valid, style: 'oil' },
      { ...valid, emote: 'wave' },
      { ...valid, look: { x: 1 } },
      { ...valid, scale: 0 },
      { ...valid, visible: 'yes' },
    ];
    for (const b of bad) expect(isRenderState(b), JSON.stringify(b)).toBe(false);
  });

  it('validates overlay config', () => {
    expect(isOverlayConfig({ displayId: '1', scaleFactor: 1.25, debug: false })).toBe(true);
    expect(isOverlayConfig({ displayId: 1, scaleFactor: 1, debug: false })).toBe(false);
    expect(isOverlayConfig({ displayId: '1', scaleFactor: 0, debug: false })).toBe(false);
  });
});

describe('emote timing', () => {
  it('pops in, floats up and fades out within the duration', () => {
    const f: EmoteFrame = { scale: 0, alpha: 0, rise: 0, wobble: 0, age: 0 };
    expect(emoteFrame(-1, f)).toBe(false);
    expect(emoteFrame(EMOTE_DURATION_MS, f)).toBe(false);
    expect(emoteFrame(Number.NaN, f)).toBe(false);
    expect(emoteFrame(0, f)).toBe(true);
    expect(f.scale).toBeLessThan(0.1);
    emoteFrame(150, f);
    const popScale = f.scale;
    emoteFrame(600, f);
    expect(popScale).toBeGreaterThan(0.9);
    expect(f.alpha).toBe(1);
    const midRise = f.rise;
    emoteFrame(1500, f);
    expect(f.rise).toBeGreaterThan(midRise);
    expect(f.alpha).toBeLessThan(0.5);
  });
});

describe('pointer input', () => {
  it('produces events that satisfy the IPC schema, clamping wild values', () => {
    const e = toPointerEvent('move', 1e9, Number.NaN, 99, -3, 12.5);
    expect(OverlayPointerEventSchema.safeParse(e).success).toBe(true);
    expect(e.x).toBe(100000);
    expect(e.y).toBe(0);
    expect(e.button).toBe(4);
    expect(e.buttons).toBe(0);
  });

  it('coalesces moves to one per frame, flushes before down/up and captures the pointer', () => {
    const listeners = new Map<string, (e: unknown) => void>();
    const captured: number[] = [];
    const target = {
      addEventListener: (k: string, fn: (e: unknown) => void) => listeners.set(k, fn),
      removeEventListener: (k: string) => listeners.delete(k),
      setPointerCapture: (id: number) => captured.push(id),
    } as unknown as HTMLElement;
    const sent: OverlayPointerEvent[] = [];
    let frame: FrameRequestCallback | null = null;
    const detach = attachPointerInput(
      target,
      (e) => sent.push(e),
      (cb) => {
        frame = cb;
        return 1;
      },
      () => {
        frame = null;
      },
    );
    const ev = (x: number, extra: Record<string, unknown> = {}) => ({ clientX: x, clientY: 5, button: 0, buttons: 1, pointerId: 7, preventDefault: () => undefined, ...extra });
    listeners.get('pointermove')!(ev(1));
    listeners.get('pointermove')!(ev(2));
    listeners.get('pointermove')!(ev(3));
    expect(sent.length).toBe(0);
    (frame as FrameRequestCallback | null)?.(0);
    expect(sent.map((s) => [s.kind, s.x])).toEqual([['move', 3]]);
    listeners.get('pointermove')!(ev(4));
    listeners.get('pointerdown')!(ev(4));
    expect(sent.map((s) => s.kind)).toEqual(['move', 'move', 'down']);
    expect(captured).toEqual([7]);
    let prevented = false;
    listeners.get('contextmenu')!(ev(4, { button: 2, preventDefault: () => (prevented = true) }));
    expect(prevented).toBe(true);
    expect(sent.at(-1)!.kind).toBe('context');
    listeners.get('pointerup')!(ev(4));
    listeners.get('pointerleave')!(ev(4));
    expect(sent.slice(-2).map((s) => s.kind)).toEqual(['up', 'leave']);
    detach();
    expect(listeners.size).toBe(0);
  });
});
