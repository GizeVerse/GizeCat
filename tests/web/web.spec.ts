// GizeCat web host E2E (ADR 0004 §8): the real page (out/web-test) in the installed Chrome and Edge
// and in Chrome's Pixel 7 emulation. Labels: the browsers, the page, the sim, the renderer and the
// router are REAL; pointer and touch input is synthesized through the DevTools protocol (trusted
// events through the browser's input pipeline, but no physical device); the mobile project is a
// device emulation (SIMULATED), not a phone.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { WebTestState } from '../../src/web/testHook';

const ROOT = path.resolve(__dirname, '..', '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const OWN_ASSETS = new Set(['/', '/index.html', '/main.js', '/web.css']);
/** States in which the cat stands still enough to be stroked, clicked or picked up. */
const CALM = new Set(['idle', 'resting', 'grooming', 'watchingUser', 'watchingCursor', 'curious', 'seekingAttention', 'sleeping']);

// The slice of the page's globals the page functions below use (the test program has no DOM lib).
interface PageEl {
  id: string;
  style: { cssText: string };
  dataset: Record<string, string | undefined>;
  addEventListener(type: string, fn: () => void, capture?: boolean): void;
  appendChild(child: PageEl): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}
interface PageCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): { getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> } } | null;
}
interface PageGlobals {
  __gizecatWebTest: { state(): WebTestState; setTimeScale(n: number): void; catAt(x: number, y: number): boolean };
  __cspViolations?: string[];
  innerWidth: number;
  innerHeight: number;
  localStorage: { getItem(k: string): string | null };
  addEventListener(type: string, fn: () => void): void;
  document: {
    body: PageEl;
    createElement(tag: 'div'): PageEl;
    getElementById(id: string): unknown;
    elementFromPoint(x: number, y: number): PageEl | null;
    querySelector(sel: string): { getAttribute(name: string): string | null } | null;
    addEventListener(type: string, fn: (e: unknown) => void): void;
  };
}

const isMobile = (info: TestInfo): boolean => info.project.name === 'mobile-emulated';

test.beforeAll(({ browser }, info) => {
  console.log(`[${info.project.name}] ${browser.browserType().name()} ${browser.version()}`);
});

test.beforeEach(({ browser }, info) => {
  info.annotations.push({ type: 'browser', description: `${info.project.name}: ${browser.version()}` });
  info.annotations.push({ type: isMobile(info) ? 'SIMULATED' : 'REAL', description: isMobile(info) ? 'Pixel 7 device emulation in Chrome; touch through CDP' : 'installed browser; pointer input through CDP' });
});

async function state(page: Page): Promise<WebTestState> {
  return page.evaluate(() => (globalThis as unknown as PageGlobals).__gizecatWebTest.state());
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const h = (globalThis as unknown as Partial<PageGlobals>).__gizecatWebTest;
      if (!h) return false;
      const s = h.state();
      return s.visible && s.bounds !== null && s.overlay.ready && s.overlay.hitReports > 0;
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Opens the page, recording console errors and every request (and whether it came after the load event). */
async function openPage(page: Page) {
  const errors: string[] = [];
  const requests: Array<{ url: string; afterLoad: boolean }> = [];
  let loaded = false;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('load', () => {
    loaded = true;
  });
  page.on('request', (r) => requests.push({ url: r.url(), afterLoad: loaded }));
  await page.addInitScript(() => {
    const g = globalThis as unknown as PageGlobals;
    const seen: string[] = [];
    g.__cspViolations = seen;
    g.document.addEventListener('securitypolicyviolation', (e: unknown) => {
      const v = e as { violatedDirective?: string; blockedURI?: string; sourceFile?: string; lineNumber?: number; sample?: string };
      seen.push(`${v.violatedDirective ?? '?'} ${v.blockedURI ?? ''} ${v.sourceFile ?? ''}:${v.lineNumber ?? ''} ${v.sample ?? ''}`);
    });
  });
  const response = await page.goto('/');
  await waitReady(page);
  return { errors, requests, response };
}

/** Waits until the cat stands still in a calm state (sped up meanwhile), then runs at real speed again. */
async function waitCalm(page: Page, timeoutMs = 60_000): Promise<WebTestState> {
  await page.evaluate(() => (globalThis as unknown as PageGlobals).__gizecatWebTest.setTimeScale(3));
  const deadline = Date.now() + timeoutMs;
  let prev: WebTestState | null = null;
  try {
    while (Date.now() < deadline) {
      const s = await state(page);
      const still = prev?.anchor && s.anchor ? Math.hypot(s.anchor.x - prev.anchor.x, s.anchor.y - prev.anchor.y) < 1 : false;
      if (still && s.visible && CALM.has(s.behavior) && s.hitRects.length > 0 && !s.router.pressed) return s;
      prev = s;
      await page.waitForTimeout(150);
    }
    throw new Error(`the cat did not settle (last state: ${prev?.behavior ?? 'none'})`);
  } finally {
    await page.evaluate(() => (globalThis as unknown as PageGlobals).__gizecatWebTest.setTimeScale(1));
  }
}

/** A point the router gives to the cat right now: the centre of its largest hit rect that is on the cat. */
async function catPoint(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    const h = (globalThis as unknown as PageGlobals).__gizecatWebTest;
    const rects = [...h.state().hitRects].sort((a, b) => b.width * b.height - a.width * a.height);
    for (const r of rects) {
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      if (h.catAt(x, y)) return { x, y };
    }
    return null;
  });
  if (!p) throw new Error('no point on the cat');
  return p;
}

/** `seq` appears in order (not necessarily adjacent) in the state history. */
function inOrder(states: readonly string[], seq: readonly string[]): boolean {
  let i = 0;
  for (const s of states) if (s === seq[i]) i++;
  return i >= seq.length;
}

async function touchInput(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  return {
    start: (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) }),
    move: (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) }),
    end: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
  };
}

test('loads with no console errors and the CSP in force (header and meta)', async ({ page }) => {
  const { errors, response } = await openPage(page);
  expect(response?.headers()['content-security-policy']).toBe(CSP);
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toBe(CSP);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('GizeCat');
  await expect(page.locator('#cat')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#cat-status')).toHaveAttribute('aria-live', 'polite');
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (globalThis as unknown as PageGlobals).__cspViolations ?? null)).toEqual([]);
  expect(errors).toEqual([]);
});

test('makes no request after load, and none but its own three files at all', async ({ page }, info) => {
  const { requests, errors } = await openPage(page);
  // Live with it for a while: the sim at speed, a pointer over the page and a button press.
  await page.evaluate(() => (globalThis as unknown as PageGlobals).__gizecatWebTest.setTimeScale(5));
  if (isMobile(info)) await page.getByRole('button', { name: 'Call the cat' }).tap();
  else {
    await page.mouse.move(200, 200);
    await page.getByRole('button', { name: 'Call the cat' }).click();
  }
  await page.waitForTimeout(4000);
  const origin = new URL(page.url()).origin;
  for (const r of requests) {
    const u = new URL(r.url);
    expect(u.origin, r.url).toBe(origin);
    expect(OWN_ASSETS.has(u.pathname), r.url).toBe(true);
  }
  expect(requests.filter((r) => r.afterLoad)).toEqual([]);
  expect(errors).toEqual([]);
});

test('draws the cat: opaque pixels at its bounds, a transparent canvas elsewhere', async ({ page }) => {
  await openPage(page);
  await page.waitForTimeout(500);
  const px = await page.evaluate(() => {
    const g = globalThis as unknown as PageGlobals;
    const s = g.__gizecatWebTest.state();
    const canvas = g.document.getElementById('cat') as PageCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx || !s.bounds) return null;
    const k = canvas.width / g.innerWidth;
    const count = (x: number, y: number, w: number, h: number): number => {
      const x0 = Math.max(0, Math.floor(x * k));
      const y0 = Math.max(0, Math.floor(y * k));
      const x1 = Math.min(canvas.width, Math.ceil((x + w) * k));
      const y1 = Math.min(canvas.height, Math.ceil((y + h) * k));
      if (x1 <= x0 || y1 <= y0) return 0;
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) n++;
      return n;
    };
    const b = s.bounds;
    // The drawn cat lags the sim a frame or two: look around its bounds.
    return { onCat: count(b.x - 40, b.y - 40, b.width + 80, b.height + 80), corner: count(0, 0, 120, 120), dpr: k };
  });
  expect(px).not.toBeNull();
  expect(px!.onCat).toBeGreaterThan(500);
  expect(px!.corner).toBe(0);
});

test('the page keeps its clicks; a click or tap on the cat stays with the cat, which reacts', async ({ page }, info) => {
  const { errors } = await openPage(page);
  const calm = await waitCalm(page);
  // A strip of page under the cat that counts what reaches it.
  const top = Math.max(0, (calm.bounds?.y ?? 0) - 30);
  await page.evaluate((stripTop) => {
    const g = globalThis as unknown as PageGlobals;
    const d = g.document.createElement('div');
    d.id = 'probe';
    d.style.cssText = `position:fixed;left:0;right:0;top:${stripTop}px;bottom:0;z-index:1;`;
    d.dataset.clicks = '0';
    d.dataset.downs = '0';
    const bump = (k: 'clicks' | 'downs') => () => {
      d.dataset[k] = String(Number(d.dataset[k]) + 1);
    };
    d.addEventListener('click', bump('clicks'));
    d.addEventListener('pointerdown', bump('downs'));
    d.addEventListener('mousedown', bump('downs'));
    d.addEventListener('touchstart', bump('downs'));
    g.document.body.appendChild(d);
  }, top);
  const before = await state(page);
  const p = await catPoint(page);
  expect(await page.evaluate(([x, y]) => (globalThis as unknown as PageGlobals).document.elementFromPoint(x!, y!)?.id ?? null, [p.x, p.y])).toBe('probe');
  if (isMobile(info)) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
  const taps = (s: WebTestState): number => (s.eventCounts['pointer.tap'] ?? 0) + (s.eventCounts['pointer.doubleTap'] ?? 0);
  await expect.poll(async () => taps(await state(page))).toBe(taps(before) + 1);
  // The cat reacts: a reaction (an ear flick) or a change of what it does.
  await expect
    .poll(async () => {
      const s = await state(page);
      return (s.reaction?.at ?? -1) !== (before.reaction?.at ?? -1) || s.states.length !== before.states.length || s.behavior !== before.behavior;
    })
    .toBe(true);
  await page.waitForTimeout(300);
  const probe = await page.evaluate(() => {
    const el = (globalThis as unknown as PageGlobals).document.getElementById('probe') as PageEl;
    return { clicks: Number(el.dataset.clicks), downs: Number(el.dataset.downs) };
  });
  expect(probe).toEqual({ clicks: 0, downs: 0 });

  // A page button far from the cat gets its real click (Pause, then Resume).
  const pause = page.getByRole('button', { name: 'Pause' });
  const box = await pause.boundingBox();
  const cat = (await state(page)).bounds;
  expect(box && cat ? box.y + box.height < cat.y || box.x > cat.x + cat.width || box.x + box.width < cat.x : false).toBe(true);
  if (isMobile(info)) await pause.tap();
  else await pause.click();
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  const resume = page.getByRole('button', { name: 'Resume' });
  if (isMobile(info)) await resume.tap();
  else await resume.click();
  await expect.poll(async () => (await state(page)).paused).toBe(false);
  expect(errors).toEqual([]);
});

test('mouse: stroking back and forth over the cat pets it', async ({ page }, info) => {
  test.skip(isMobile(info), 'the touch project strokes with a finger');
  const { errors } = await openPage(page);
  await waitCalm(page);
  const deadline = Date.now() + 30_000;
  let s = await state(page);
  while (!s.states.includes('beingPetted') && Date.now() < deadline) {
    const p = await catPoint(page);
    let x = p.x - 20;
    await page.mouse.move(x, p.y);
    for (let leg = 0; leg < 6; leg++) {
      const dir = leg % 2 === 0 ? 1 : -1;
      for (let i = 0; i < 5; i++) {
        x += dir * 8;
        await page.mouse.move(x, p.y);
        await page.waitForTimeout(35);
      }
    }
    s = await state(page);
  }
  expect(s.eventCounts['pointer.pet'] ?? 0).toBeGreaterThan(0);
  expect(s.states).toContain('beingPetted');
  expect(s.eventCounts['pointer.dragStart'] ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test('mouse: dragging the cat holds it; letting go drops it (falling, then landing)', async ({ page }, info) => {
  test.skip(isMobile(info), 'the touch project drags with a held finger');
  const { errors } = await openPage(page);
  await waitCalm(page);
  const p = await catPoint(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(p.x, p.y - i * 15);
    await page.waitForTimeout(20);
  }
  await expect.poll(async () => (await state(page)).behavior).toBe('held');
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect.poll(async () => inOrder((await state(page)).states, ['held', 'falling', 'landing'])).toBe(true);
  const s = await state(page);
  expect(s.router.pressed).toBe(false);
  expect([s.eventCounts['pointer.dragStart'], s.eventCounts['pointer.dragEnd']]).toEqual([1, 1]);
  expect(errors).toEqual([]);
});

test('touch: a finger stroking the cat pets it (no pick-up)', async ({ page }, info) => {
  test.skip(!isMobile(info), 'touch only');
  const { errors } = await openPage(page);
  await waitCalm(page);
  const touch = await touchInput(page);
  const deadline = Date.now() + 30_000;
  let s = await state(page);
  while (!s.states.includes('beingPetted') && Date.now() < deadline) {
    const p = await catPoint(page);
    let x = p.x - 20;
    await touch.start(x, p.y);
    for (let leg = 0; leg < 6; leg++) {
      const dir = leg % 2 === 0 ? 1 : -1;
      for (let i = 0; i < 5; i++) {
        x += dir * 8;
        await touch.move(x, p.y);
        await page.waitForTimeout(35);
      }
    }
    await touch.end();
    s = await state(page);
  }
  expect(s.eventCounts['pointer.pet'] ?? 0).toBeGreaterThan(0);
  expect(s.states).toContain('beingPetted');
  expect(s.eventCounts['pointer.dragStart'] ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test('touch: press and hold picks the cat up, a drag carries it, letting go drops it', async ({ page }, info) => {
  test.skip(!isMobile(info), 'touch only');
  const { errors } = await openPage(page);
  await waitCalm(page);
  const touch = await touchInput(page);
  const p = await catPoint(page);
  await touch.start(p.x, p.y);
  await page.waitForTimeout(500);
  expect((await state(page)).router.touchMode).toBe('drag');
  for (let i = 1; i <= 10; i++) {
    await touch.move(p.x, p.y - i * 15);
    await page.waitForTimeout(20);
  }
  await expect.poll(async () => (await state(page)).behavior).toBe('held');
  await page.waitForTimeout(250);
  await touch.end();
  await expect.poll(async () => inOrder((await state(page)).states, ['held', 'falling', 'landing'])).toBe(true);
  const s = await state(page);
  expect([s.eventCounts['pointer.dragStart'], s.eventCounts['pointer.dragEnd']]).toEqual([1, 1]);
  expect(s.eventCounts['pointer.tap'] ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test('a reload keeps the cat (localStorage)', async ({ page }) => {
  const { errors } = await openPage(page);
  await page.waitForTimeout(500);
  const before = await state(page);
  expect(before.storage.available).toBe(true);
  expect(before.storage.catSource).toBe('new');
  await page.reload();
  await waitReady(page);
  const after = await state(page);
  expect(after.storage.catSource).toBe('stored');
  expect(after.storage.catId).toBe(before.storage.catId);
  const stored = await page.evaluate(() => (globalThis as unknown as PageGlobals).localStorage.getItem('gizecat.web.cat.v1'));
  expect((JSON.parse(stored ?? '{}') as { catId?: string }).catId).toBe(before.storage.catId);
  expect(errors).toEqual([]);
});

test('a hidden page lets the cat nap (system suspend, not a user pause); shown again, it wakes', async ({ page }) => {
  const { errors } = await openPage(page);
  await page.evaluate(() => (globalThis as unknown as PageGlobals).__gizecatWebTest.setTimeScale(5));
  // SIMULATED visibility: the page reports itself hidden and raises visibilitychange.
  const setVisibility = (v: 'hidden' | 'visible') =>
    page.evaluate((vis) => {
      const g = globalThis as unknown as PageGlobals & { document: { dispatchEvent(e: unknown): boolean } };
      Object.defineProperty(g.document, 'visibilityState', { configurable: true, get: () => vis });
      Object.defineProperty(g.document, 'hidden', { configurable: true, get: () => vis === 'hidden' });
      const E = (globalThis as unknown as { Event: new (type: string) => unknown }).Event;
      g.document.dispatchEvent(new E('visibilitychange'));
    }, v);
  await setVisibility('hidden');
  await expect.poll(async () => (await state(page)).suspended).toBe(true);
  await expect.poll(async () => ['fallingAsleep', 'sleeping'].includes((await state(page)).behavior)).toBe(true);
  const asleep = await state(page);
  expect(asleep.paused).toBe(false);
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await setVisibility('visible');
  await expect.poll(async () => (await state(page)).suspended).toBe(false);
  await expect.poll(async () => (await state(page)).states.slice(asleep.states.length).includes('wakingUp')).toBe(true);
  expect(errors).toEqual([]);
});

test('the production build (out/web) has no test hook and no key listener', ({ page: _page }, info) => {
  test.skip(info.project.name !== 'chrome', 'a file scan: once is enough');
  const dir = path.join(ROOT, 'out', 'web');
  const files = fs.readdirSync(dir).sort();
  expect(files).toEqual(['index.html', 'main.js', 'web.css']);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    expect(text, f).not.toContain('__gizecatWebTest');
    expect(text, f).not.toMatch(/key(down|up|press)/i);
  }
  expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain(CSP);
  // The scan can see a hook: the test build has one.
  expect(fs.readFileSync(path.join(ROOT, 'out', 'web-test', 'main.js'), 'utf8')).toContain('__gizecatWebTest');
});
