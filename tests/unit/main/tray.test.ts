// The tray icon as the notification surface of the one-time launch-at-sign-in notice
// (startup#8): a tray balloon (a toast on Windows 10/11) whose show and click events reach the
// notice's handlers. MOCKED: Electron's Tray, Menu and nativeImage.
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  const image = { isEmpty: () => false };
  return {
    FakeTray,
    image,
    module: {
      Tray: FakeTray,
      Menu: { buildFromTemplate: () => ({}) },
      nativeImage: { createFromPath: () => image, createFromBitmap: () => image },
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
