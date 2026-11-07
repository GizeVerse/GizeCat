// The tray icon as the notification surface of the one-time launch-at-sign-in notice
// (startup#8): a tray balloon (a toast on Windows 10/11) whose show and click events reach the
// notice's handlers. MOCKED: Electron's Tray, Menu and nativeImage.
// 1.4.0 (macOS, D5): template menu-bar images and no click toggle. MOCKED as well: no Mac run.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drawTrayBitmap, drawTrayTemplateBitmap } from '../../../src/main/lifecycle/trayIcon';
import type { TrayIconVariant } from '../../../src/main/lifecycle/menuModel';
import { createTrayController } from '../../../src/main/tray';
import { memoryLogger } from './helpers';

const electron = vi.hoisted(() => {
  type Listener = () => void;
  class FakeTray {
    static last: FakeTray | null = null;
    readonly listeners = new Map<string, Listener[]>();
    readonly balloons: unknown[] = [];
    destroyed = false;
    constructor() {
      FakeTray.last = this;
    }
    on(event: string, fn: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
      return this;
    }
    emit(event: string): void {
      for (const fn of this.listeners.get(event) ?? []) fn();
    }
    setToolTip(): void {}
    setContextMenu(): void {}
    setImage(): void {}
    displayBalloon(options: unknown): void {
      this.balloons.push(options);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  /** What the icon code asked nativeImage for (1.4.0 template tests). */
  const state = { emptyPaths: false, paths: [] as string[], bitmaps: [] as Array<{ size: number; opts: unknown }>, template: [] as boolean[] };
  const image = { isEmpty: () => false, setTemplateImage: (on: boolean) => void state.template.push(on) };
  const empty = { isEmpty: () => true, setTemplateImage: (on: boolean) => void state.template.push(on) };
  return {
    FakeTray,
    image,
    state,
    module: {
      Tray: FakeTray,
      Menu: { buildFromTemplate: () => ({}) },
      nativeImage: {
        createFromPath: (p: string) => {
          state.paths.push(p);
          return state.emptyPaths ? empty : image;
        },
        createFromBitmap: (buf: Buffer, opts: unknown) => {
          state.bitmaps.push({ size: buf.length, opts });
          return image;
        },
      },
    },
  };
});
vi.mock('electron', () => electron.module);

function tray() {
  const log = memoryLogger();
  const controller = createTrayController({ iconDir: 'C:\\app\\assets\\tray', logger: log, onAction: () => undefined, onClick: () => undefined });
  const fake = electron.FakeTray.last;
  if (!fake) throw new Error('no tray created');
  return { controller, fake, log };
}

const notice = { title: 'GizeCat now starts with Windows', body: 'Your cat appears when you sign in.' };

describe('tray notification surface', () => {
  beforeEach(() => {
    electron.FakeTray.last = null;
  });

  it('shows the notice as a balloon that respects quiet time and Do not disturb', () => {
    const { controller, fake } = tray();
    const handlers = { onShown: vi.fn(), onClick: vi.fn() };
    expect(controller.notify(notice, handlers)).toBe(true);
    expect(fake.balloons).toEqual([{ title: notice.title, content: notice.body, icon: electron.image, respectQuietTime: true }]);
    // Nothing is reported until Windows displays it.
    expect(handlers.onShown).not.toHaveBeenCalled();
  });

  it('balloon-show reports it displayed and balloon-click reports the click', () => {
    const { controller, fake } = tray();
    const handlers = { onShown: vi.fn(), onClick: vi.fn() };
    // Events before any notice reach no one.
    fake.emit('balloon-show');
    controller.notify(notice, handlers);
    fake.emit('balloon-show');
    fake.emit('balloon-click');
    expect(handlers.onShown).toHaveBeenCalledTimes(1);
    expect(handlers.onClick).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler is logged, never thrown into Electron', () => {
    const { controller, fake, log } = tray();
    controller.notify(notice, {
      onShown: () => {
        throw new Error('settings store gone');
      },
      onClick: () => undefined,
    });
    expect(() => fake.emit('balloon-show')).not.toThrow();
    expect(log.entries.some((e) => e.level === 'error' && /notification show handler failed/.test(e.msg))).toBe(true);
  });

  it('cannot notify once disposed, and a late event reaches no handler', () => {
    const { controller, fake } = tray();
    const handlers = { onShown: vi.fn(), onClick: vi.fn() };
    controller.notify(notice, handlers);
    controller.dispose();
    fake.emit('balloon-click');
    expect(handlers.onClick).not.toHaveBeenCalled();
    expect(controller.notify(notice, handlers)).toBe(false);
    expect(fake.balloons).toHaveLength(1);
  });
});

describe('tray notices off Windows (ADR 0004 §3)', () => {
  beforeEach(() => {
    electron.FakeTray.last = null;
  });

  it('without balloons notify() reports false and shows nothing (displayBalloon exists on Windows only)', () => {
    const controller = createTrayController({ iconDir: '/app/assets/tray', logger: memoryLogger(), onAction: () => undefined, onClick: () => undefined, balloons: false });
    const handlers = { onShown: vi.fn(), onClick: vi.fn() };
    expect(controller.notify(notice, handlers)).toBe(false);
    expect(electron.FakeTray.last?.balloons).toEqual([]);
    expect(handlers.onShown).not.toHaveBeenCalled();
  });
});

describe('tray icon and click, Windows and macOS (1.4.0, D5)', () => {
  beforeEach(() => {
    electron.FakeTray.last = null;
    electron.state.emptyPaths = false;
    electron.state.paths.length = 0;
    electron.state.bitmaps.length = 0;
    electron.state.template.length = 0;
  });

  it('Windows (the default): a left click runs onClick, the coloured PNGs are used and nothing is a template', () => {
    const onClick = vi.fn();
    createTrayController({ iconDir: 'C:\\app\\assets\\tray', logger: memoryLogger(), onAction: () => undefined, onClick });
    const fake = electron.FakeTray.last;
    if (!fake) throw new Error('no tray created');
    expect(fake.listeners.get('click')).toHaveLength(1);
    fake.emit('click');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(electron.state.paths[0]).toMatch(/tray\.png$/);
    expect(electron.state.template).toEqual([]);
  });

  it('macOS: no click listener at all, so opening the menu never hides or shows the cat', () => {
    const onClick = vi.fn();
    createTrayController({ iconDir: '/app/assets/tray', logger: memoryLogger(), onAction: () => undefined, onClick, balloons: false, template: true, clickToggles: false });
    const fake = electron.FakeTray.last;
    if (!fake) throw new Error('no tray created');
    expect(fake.listeners.has('click')).toBe(false);
    fake.emit('click');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('macOS: a template image, generated at 32 px @2x when no <variant>Template.png ships, without a "missing asset" warning', () => {
    electron.state.emptyPaths = true;
    const log = memoryLogger();
    createTrayController({ iconDir: '/app/assets/tray', logger: log, onAction: () => undefined, onClick: () => undefined, template: true, clickToggles: false });
    expect(electron.state.paths).toEqual([expect.stringMatching(/trayTemplate\.png$/)]);
    expect(electron.state.bitmaps).toEqual([{ size: 32 * 32 * 4, opts: { width: 32, height: 32, scaleFactor: 2 } }]);
    expect(electron.state.template).toEqual([true]);
    expect(log.entries.some((e) => e.level === 'warn')).toBe(false);
  });

  it('macOS: a shipped <variant>Template.png is used as is and still marked as a template', () => {
    createTrayController({ iconDir: '/app/assets/tray', logger: memoryLogger(), onAction: () => undefined, onClick: () => undefined, template: true, clickToggles: false });
    expect(electron.state.bitmaps).toEqual([]);
    expect(electron.state.template).toEqual([true]);
  });
});

describe('drawTrayTemplateBitmap (macOS template images, pure)', () => {
  const VARIANTS: TrayIconVariant[] = ['tray', 'tray-paused', 'tray-vision'];
  const alphaMask = (buf: Buffer): string => {
    let s = '';
    for (let i = 3; i < buf.length; i += 4) s += buf[i] === 0 ? '.' : '#';
    return s;
  };

  it('is black plus alpha only: RGB 0 everywhere, alpha either 0 or 255', () => {
    for (const v of VARIANTS) {
      const buf = drawTrayTemplateBitmap(v, 32);
      expect(buf.length, v).toBe(32 * 32 * 4);
      for (let i = 0; i < buf.length; i += 4) {
        expect([buf[i], buf[i + 1], buf[i + 2]], `${v} pixel ${i / 4}`).toEqual([0, 0, 0]);
        expect([0, 255], `${v} alpha ${i / 4}`).toContain(buf[i + 3]);
      }
    }
  });

  it('gives every state its own shape (colour is lost in a template), each with a visible silhouette', () => {
    const masks = VARIANTS.map((v) => alphaMask(drawTrayTemplateBitmap(v, 32)));
    expect(new Set(masks).size).toBe(VARIANTS.length);
    for (const m of masks) expect((m.match(/#/g) ?? []).length).toBeGreaterThan(200);
    // The vision indicator (a privacy signal) differs from the plain icon by a clear margin, not a few pixels.
    const [plain, , vision] = masks;
    let diff = 0;
    for (let i = 0; i < plain!.length; i++) if (plain![i] !== vision![i]) diff++;
    expect(diff).toBeGreaterThan(40);
  });

  it('scales with the size (16 px for 1x) and leaves the coloured Windows icon untouched', () => {
    expect(drawTrayTemplateBitmap('tray', 16).length).toBe(16 * 16 * 4);
    const colored = drawTrayBitmap('tray', 32);
    // The coloured icon keeps its orange body (BGRA: B=0x5a, G=0xa6, R=0xf2) somewhere.
    let orange = false;
    for (let i = 0; i < colored.length; i += 4) if (colored[i] === 0x5a && colored[i + 1] === 0xa6 && colored[i + 2] === 0xf2) orange = true;
    expect(orange).toBe(true);
  });
});
