import { describe, expect, it } from 'vitest';
import { WorldModel } from '../../../../src/core/movement';
import { display, DUAL_FLAT, DUAL_MIXED, ledge, sideId, SINGLE, taskbarId, topId, wall, world } from '../behavior/fixtures';

describe('WorldModel', () => {
  it('puts a floor at the bottom of each work area, inset by half the cat width', () => {
    const w = new WorldModel(SINGLE, 1, true);
    expect(w.floors).toHaveLength(1);
    const f = w.firstFloor;
    expect(f.y).toBe(1040);
    expect(f.x0).toBe(42);
    expect(f.x1).toBe(1920 - 42);
  });

  it('joins floors of side-by-side displays at the same height only when allowed', () => {
    const joined = new WorldModel(DUAL_FLAT, 1, true);
    expect(joined.floors).toHaveLength(1);
    expect(joined.firstFloor.displayIds).toEqual(['1', '2']);
    expect(joined.firstFloor.x1).toBe(3840 - 42);
    const separate = new WorldModel(DUAL_FLAT, 1, false);
    expect(separate.floors).toHaveLength(2);
  });

  it('keeps floors of different heights separate (mixed DPI, negative coordinates)', () => {
    const w = new WorldModel(DUAL_MIXED, 1, true);
    expect(w.floors).toHaveLength(2);
    const f2 = w.floorFor('2');
    expect(f2?.y).toBe(-180 + 1440);
    // 1.5x scale: half width 63 px.
    expect(f2?.x0).toBe(-2560 + 63);
    expect(f2?.x1).toBe(-63);
    expect(w.scaleAt({ x: -100, y: 0 })).toBe(1.5);
    expect(w.displayAt({ x: -1, y: 1260 })?.id).toBe('2');
    expect(w.displayAt({ x: 0, y: 1100 })).toBeNull();
  });

  it('clamps points into the union of work areas', () => {
    const w = new WorldModel(DUAL_MIXED, 1, true);
    for (const p of [
      { x: 5000, y: 500 },
      { x: -9000, y: -9000 },
      { x: 500, y: 1070 }, // inside the taskbar
      { x: Number.NaN, y: 3 },
    ]) {
      const q = w.clampInside(p);
      expect(w.contains(q, 0.02)).toBe(true);
    }
    expect(w.clampInside({ x: 500, y: 1070 })).toEqual({ x: 500, y: 1040 });
  });

  it('uses tab-strip spans as given (they are already safe anchor spans, never narrowed twice)', () => {
    const w = new WorldModel(SINGLE, 1, true);
    // 40 px anchor span: shorter than a body, but valid because the provider already inset it by half the cat.
    const [strip] = w.ledgeSurfaces([ledge('tabStrip:b', 'tabStrip', 'b', 600, 400, 440)]);
    expect(strip).toMatchObject({ surfaceKind: 'tabStrip', x0: 400, x1: 440 });
    // A window top with the same span is too narrow to stand on.
    expect(w.ledgeSurfaces([ledge(topId('c'), 'windowTop', 'c', 600, 400, 440)])).toEqual([]);
  });

  it('finds the first surface below a point, preferring window tops above the floor', () => {
    const w = new WorldModel(SINGLE, 1, true);
    const ledges = w.ledgeSurfaces([ledge(topId('a'), 'windowTop', 'a', 600, 400, 900)]);
    expect(ledges).toHaveLength(1);
    expect(ledges[0]).toMatchObject({ kind: 'ledge', surfaceId: topId('a'), surfaceKind: 'windowTop', ownerId: 'a', y: 600, landX0: 400, landX1: 900 });
    // Window tops: the stand range is inset by a quarter body width (84 px at 1x).
    expect(ledges[0]?.x0).toBe(400 + 21);
    expect(w.surfaceBelow(500, 300, ledges)?.surface.surfaceId).toBe(topId('a'));
    expect(w.surfaceBelow(500, 700, ledges)?.surface.kind).toBe('floor');
    expect(w.surfaceBelow(1500, 300, ledges)?.y).toBe(1040);
  });

  it('rejects ledges that are too narrow, too close to the top or to the floor, off screen, malformed or not horizontal', () => {
    const w = new WorldModel(SINGLE, 1, true);
    const s = w.ledgeSurfaces([
      ledge(topId('narrow'), 'windowTop', 'narrow', 500, 100, 150),
      ledge(topId('top'), 'windowTop', 'top', 10, 100, 900),
      ledge(topId('floor'), 'windowTop', 'floor', 1030, 100, 900),
      ledge(topId('off'), 'windowTop', 'off', 500, 4000, 4800),
      ledge(topId('nan'), 'windowTop', 'nan', Number.NaN, 100, 900),
      ledge(taskbarId('top'), 'taskbar', 'tb', 600, 0, 1920, { edge: 'top' }),
      ledge(topId('ok'), 'windowTop', 'ok', 500, 100, 900),
      ledge(topId('ok'), 'windowTop', 'dup', 400, 100, 900),
    ]);
    expect(s.map((x) => x.surfaceId)).toEqual([topId('ok')]);
  });

  it('keeps a bottom taskbar just above the floor (which a window top that low is not), and spans it like a floor', () => {
    const w = new WorldModel(world(display('1', 0, 0, 1920, 1200, { primary: true })), 1, true);
    const s = w.ledgeSurfaces([ledge(taskbarId('t'), 'taskbar', 't', 1139, 0, 1920, { edge: 'bottom' }), ledge(topId('low'), 'windowTop', 'low', 1170, 100, 900)]);
    expect(s.map((x) => x.surfaceKind)).toEqual(['taskbar']);
    expect(s[0]).toMatchObject({ x0: 42, x1: 1920 - 42 });
    // A docked taskbar below the work area is the floor already.
    expect(w.ledgeSurfaces([ledge(taskbarId('t'), 'taskbar', 't', 1199, 0, 1920, { edge: 'bottom' })])).toEqual([]);
  });

  it('turns window sides into climbable walls on their outside, with room beside them', () => {
    const w = new WorldModel(SINGLE, 1, true);
    const tracks = w.wallTracks([
      wall('a', 'left', 600, 300, 900),
      wall('a', 'right', 1200, 300, 900),
      // Flush with the screen edge: no room to hang beside it.
      wall('b', 'left', 0, 300, 900),
      // Too short to climb.
      wall('c', 'right', 1200, 300, 340),
    ]);
    expect(tracks.map((t) => t.key)).toEqual([sideId('a', 'left'), sideId('a', 'right')]);
    const [left, right] = tracks;
    expect(left).toMatchObject({ x: 600, side: 'left', facing: 1, topLedgeId: topId('a'), yBottom: 900 });
    expect(right).toMatchObject({ x: 1200, side: 'right', facing: -1 });
    // The cat stands outside the window before climbing, and its head peeks over the corner at the top.
    expect(left?.standX).toBeLessThan(600);
    expect(right?.standX).toBeGreaterThan(1200);
    expect(left?.yTop).toBeGreaterThan(300);
    expect(left?.yTop).toBeLessThan(300 + 84);
    // A wall reaching below the floor ends at the floor.
    expect(w.wallTrack(wall('d', 'left', 600, 300, 2000))?.yBottom).toBe(1040);
  });

  it('caps ledges and walls per kind in list order, but always keeps the ids the cat is on or heading for', () => {
    const w = new WorldModel(SINGLE, 1, true);
    const ledges = Array.from({ length: 8 }, (_, i) => ledge(topId(`w${i}`), 'windowTop', `w${i}`, 300 + i * 50, 100 + i * 10, 500 + i * 10));
    expect(w.ledgeSurfaces(ledges, new Set(), 3).map((s) => s.key)).toEqual([topId('w0'), topId('w1'), topId('w2')]);
    // The kept one (far down the list) makes the cut; the others fill up the rest, first come first served.
    const kept = w.ledgeSurfaces(ledges, new Set([topId('w6')]), 3);
    expect(kept.map((s) => s.key)).toEqual([topId('w0'), topId('w1'), topId('w6')]);
    expect(kept).toHaveLength(3);
    const walls = Array.from({ length: 6 }, (_, i) => wall(`w${i}`, 'left', 300 + i * 200, 300, 900));
    expect(w.wallTracks(walls, new Set([sideId('w5', 'left')]), 2).map((t) => t.key)).toEqual([sideId('w0', 'left'), sideId('w5', 'left')]);
    // Duplicates keep their first entry, also for a kept id.
    expect(w.ledgeSurfaces([ledges[2]!, { ...ledges[2]!, y: 800 }], new Set([topId('w2')]), 3).map((s) => s.y)).toEqual([400]);
  });

  it('falls back to a default display for an empty world', () => {
    const w = new WorldModel(world(), 1, true);
    expect(w.usedFallback).toBe(true);
    expect(w.floors).toHaveLength(1);
    const bad = new WorldModel(world(display('x', 0, 0, 0, 0)), 1, true);
    expect(bad.usedFallback).toBe(true);
  });
});
