// The REAL probe's web-content accessibility check (tests/integration/uia/activation.ts), on
// recorded numbers: pure, no browser.
import { describe, expect, it } from 'vitest';
import { ACTIVATION_GROWTH_MB, checkActivation, heavyPageUrl, HEAVY_PARAGRAPHS, MAX_URL_CHARS, processDeltas, settled, type ProcSample } from '../../integration/uia/activation';

const BROWSER = 4100;
const RENDERER = 4200;
const GPU = 4300;
const s = (pid: number, privateMB: number, cpuMs = 0): ProcSample => ({ pid, privateMB, cpuMs });

describe('probe activation check', () => {
  it('sees an activation that lands in the renderer while the browser process stays flat', () => {
    // A review run on Edge 156 (naive FindAll over descendants, heavy page active): the browser
    // process 62.1 -> 62.1 MB, the active renderer 166.4 -> 210.1 MB. The old guard looked at the
    // browser process alone (fail above +25 MB), so it passed this.
    const before = [s(BROWSER, 62.1, 900), s(RENDERER, 166.4, 400), s(GPU, 80, 300)];
    const after = [s(BROWSER, 62.1, 2100), s(RENDERER, 210.1, 5900), s(GPU, 80.4, 320)];
    const c = checkActivation(before, after);
    expect(c).toMatchObject({ detected: true, pid: RENDERER, maxGrowthMB: 43.7, thresholdMB: ACTIVATION_GROWTH_MB });
    expect(after[0]!.privateMB - before[0]!.privateMB).toBeLessThan(25);
    expect(c.deltas.map((d) => d.pid)).toEqual([RENDERER, GPU, BROWSER]);
    expect(c.deltas[0]!.cpuMs).toBe(5500);
  });

  it('sees one in the browser process too (research: +59 / +62 MB there)', () => {
    expect(checkActivation([s(BROWSER, 63.2), s(RENDERER, 170)], [s(BROWSER, 122.2), s(RENDERER, 171)])).toMatchObject({ detected: true, pid: BROWSER });
  });

  it('idle drift, shrinking processes and processes that came or went are not an activation', () => {
    const before = [s(BROWSER, 54.8), s(RENDERER, 166.4), s(GPU, 90)];
    const after = [s(BROWSER, 57.9), s(RENDERER, 160.2), s(9999, 300)];
    const c = checkActivation(before, after);
    expect(c.detected).toBe(false);
    expect(c.maxGrowthMB).toBe(3.1);
    expect(c.deltas).toHaveLength(2);
    expect(checkActivation([], after)).toMatchObject({ detected: false, maxGrowthMB: 0, pid: null });
    expect(checkActivation(before, before.map((p) => s(p.pid, p.privateMB - 5)))).toMatchObject({ detected: false, maxGrowthMB: 0, pid: null });
  });

  it('settled: the same processes, none moved by more than the tolerance', () => {
    const a = [s(BROWSER, 60), s(RENDERER, 150)];
    expect(settled(a, [s(BROWSER, 61.5), s(RENDERER, 148.5)], 2)).toBe(true);
    expect(settled(a, [s(BROWSER, 60), s(RENDERER, 160)], 2)).toBe(false);
    expect(settled(a, [s(BROWSER, 60)], 2)).toBe(false);
    expect(settled(a, [s(BROWSER, 60), s(GPU, 150)], 2)).toBe(false);
    expect(settled([], [], 2)).toBe(false);
    expect(processDeltas(a, a).every((d) => d.growthMB === 0)).toBe(true);
  });

  it('the heavy page is a short data: URL that builds the research page size', () => {
    const url = heavyPageUrl();
    expect(url.startsWith('data:text/html,')).toBe(true);
    expect(url.length).toBeLessThan(MAX_URL_CHARS);
    // One argument: nothing a command line would split or quote, nothing that would cut the URL.
    expect(url).not.toMatch(/[\s"#]/);
    const html = decodeURIComponent(url.slice('data:text/html,'.length));
    expect(html).toContain(`i<${HEAVY_PARAGRAPHS}`);
    expect(html).toContain('<script>');
    expect(decodeURIComponent(heavyPageUrl(5).slice('data:text/html,'.length))).toContain('i<5;');
  });
});
