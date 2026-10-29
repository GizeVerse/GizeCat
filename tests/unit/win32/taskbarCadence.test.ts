// Cadence policy of the taskbar tracker: 250 ms idle, 16 ms bursts (pure).
import { describe, expect, it } from 'vitest';
import { BURST_SAMPLE_MS, cursorAtAutoHideEdge, IDLE_SAMPLE_MS, nextSampleDelay, type CadenceTaskbar } from '../../../src/main/win32/taskbar/cadence';

const MON = { left: 0, top: 0, right: 1920, bottom: 1200 };
const bar = (over: Partial<CadenceTaskbar> = {}): CadenceTaskbar => ({ autoHide: true, edge: 'bottom', monitor: MON, scale: 1, revealedPx: 0, easing: false, ...over });
const base = { now: 10_000, cursor: null, catNear: false, lastChangeAt: null, taskbars: [bar()] };

describe('taskbar sampling cadence', () => {
  it('idles at 4 Hz with nothing going on', () => {
    expect(IDLE_SAMPLE_MS).toBe(250);
    expect(BURST_SAMPLE_MS).toBe(16);
    expect(nextSampleDelay(base)).toEqual({ delayMs: 250, reason: null });
    expect(nextSampleDelay({ ...base, cursor: { x: 900, y: 600 } })).toEqual({ delayMs: 250, reason: null });
  });

  it('bursts while the cat is on or near a taskbar', () => {
    expect(nextSampleDelay({ ...base, catNear: true })).toEqual({ delayMs: 16, reason: 'cat-near' });
  });

  it('bursts for 300 ms after the last geometry change', () => {
    expect(nextSampleDelay({ ...base, lastChangeAt: 9_701 })).toEqual({ delayMs: 16, reason: 'recent-change' });
    expect(nextSampleDelay({ ...base, lastChangeAt: 9_700 }).delayMs).toBe(250);
  });

  it('bursts while an unobserved jump is eased', () => {
    expect(nextSampleDelay({ ...base, taskbars: [bar({ easing: true })] })).toEqual({ delayMs: 16, reason: 'easing' });
  });

  it('bursts with the cursor within 6 px (DPI-scaled) of an auto-hide edge only', () => {
    expect(nextSampleDelay({ ...base, cursor: { x: 900, y: 1199 } }).reason).toBe('cursor-at-edge');
    expect(nextSampleDelay({ ...base, cursor: { x: 900, y: 1193 } }).reason).toBe('cursor-at-edge'); // 6 px
    expect(nextSampleDelay({ ...base, cursor: { x: 900, y: 1192 } }).delayMs).toBe(250); // 7 px
    // 125 %: ceil(6 * 1.25) = 8 px.
    const scaled = { ...base, taskbars: [bar({ scale: 1.25 })] };
    expect(nextSampleDelay({ ...scaled, cursor: { x: 900, y: 1191 } }).reason).toBe('cursor-at-edge');
    expect(nextSampleDelay({ ...scaled, cursor: { x: 900, y: 1190 } }).delayMs).toBe(250);
    // Not on that monitor, or not an auto-hide taskbar.
    expect(nextSampleDelay({ ...base, cursor: { x: 2500, y: 1199 } }).delayMs).toBe(250);
    expect(nextSampleDelay({ ...base, taskbars: [bar({ autoHide: false })], cursor: { x: 900, y: 1199 } }).delayMs).toBe(250);
    // Non-finite cursor values are ignored.
    expect(nextSampleDelay({ ...base, cursor: { x: Number.NaN, y: 1199 } }).delayMs).toBe(250);
  });

  it('keeps bursting while the cursor is over the revealed part of the taskbar', () => {
    const revealed = bar({ revealedPx: 60 });
    expect(cursorAtAutoHideEdge({ x: 900, y: 1150 }, revealed)).toBe(true);
    expect(cursorAtAutoHideEdge({ x: 900, y: 1133 }, revealed)).toBe(true); // 66 px from the edge
    expect(cursorAtAutoHideEdge({ x: 900, y: 1132 }, revealed)).toBe(false);
    expect(cursorAtAutoHideEdge({ x: 900, y: 1150 }, bar())).toBe(false);
    expect(cursorAtAutoHideEdge({ x: 3, y: 600 }, bar({ edge: 'left' }))).toBe(true);
  });

  it('idles without taskbars, whatever the inputs', () => {
    expect(nextSampleDelay({ ...base, taskbars: [], catNear: true, lastChangeAt: 10_000 })).toEqual({ delayMs: 250, reason: null });
  });
});
