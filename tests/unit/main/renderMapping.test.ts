// Mapping of the simulation's one-off reaction into the overlay render snapshot.
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimOutput } from '../../../src/shared/sim';
import { hiddenRenderState, mapRenderState, type RenderMapContext } from '../../../src/main/overlay/renderMapping';

function output(over: Partial<SimOutput> = {}): SimOutput {
  return {
    x: 400,
    y: 600,
    facing: 1,
    state: 'idle',
    clip: 'sit',
    clipStartedAt: 10,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0.4,
    contentment: 0.7,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    snap: false,
    displayId: '1',
    support: { kind: 'floor', displayId: '1' },
    boundsPx: { x: 360, y: 540, width: 84, height: 64 },
    nextTickMs: 33,
    requests: [],
    ...over,
  };
}

const ctx: RenderMapContext = { seq: 3, toLocalDip: (p) => ({ x: p.x / 1.25, y: p.y / 1.25 }), scaleFactor: 1.25, forceSnap: false, hidden: false, simNow: 5000 };

describe('reaction mapping', () => {
  it('carries the reaction kind and start time unchanged (sim time, not converted)', () => {
    const reaction = { kind: 'earFlick', at: 4980 } as const;
    const out = output({ reaction });
    const s = mapRenderState(out, defaultSettings().appearance, ctx);
    expect(s.reaction).toEqual({ kind: 'earFlick', at: 4980 });
    // A copy: later changes to the sim's object never leak into a snapshot already sent.
    expect(s.reaction).not.toBe(out.reaction);
    for (const kind of ['tailFlick', 'headTilt'] as const) {
      expect(mapRenderState(output({ reaction: { kind, at: 12 } }), defaultSettings().appearance, ctx).reaction).toEqual({ kind, at: 12 });
    }
  });

  it('maps a missing or null reaction to null', () => {
    expect(mapRenderState(output(), defaultSettings().appearance, ctx).reaction).toBeNull();
    expect(mapRenderState(output({ reaction: null }), defaultSettings().appearance, ctx).reaction).toBeNull();
  });

  it('the final hidden frame keeps the same reaction, so nothing replays when the cat comes back', () => {
    const s = mapRenderState(output({ reaction: { kind: 'headTilt', at: 4000 } }), defaultSettings().appearance, ctx);
    expect(hiddenRenderState(s, 4, 5100).reaction).toEqual({ kind: 'headTilt', at: 4000 });
  });
});
