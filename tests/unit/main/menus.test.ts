import { describe, expect, it } from 'vitest';
import { catContextMenuModel, trayIconVariant, trayMenuModel, trayTooltip, type MenuContext, type MenuItemModel } from '../../../src/main/lifecycle/menuModel';
import { drawTrayBitmap } from '../../../src/main/lifecycle/trayIcon';

const base: MenuContext = {
  catName: 'Miso',
  hidden: false,
  paused: false,
  state: 'idle',
  interactionsEnabled: true,
  perceptionConfigured: false,
  perceptionPaused: false,
  perceptionMode: 'off',
};

const actions = (items: MenuItemModel[]) => items.flatMap((i) => (i.kind === 'separator' ? [] : [i.action]));

describe('tray menu', () => {
  it('has the documented entries and hides vision controls until perception is configured', () => {
    expect(actions(trayMenuModel(base))).toEqual(['hide', 'pause', 'toggleInteractions', 'callCat', 'startLaserMode', 'pauseEvents', 'settings', 'quit']);
    const vision = trayMenuModel({ ...base, perceptionConfigured: true, perceptionMode: 'ai-cloud' });
    const item = vision.find((i) => i.kind === 'item' && i.action === 'privacyPause');
    expect(item && item.kind === 'item' ? item.label : '').toBe('Vision (AI (cloud)): privacy pause');
    expect(actions(trayMenuModel({ ...base, perceptionConfigured: true, perceptionPaused: true }))).toContain('privacyResume');
  });

  it('flips show/hide, pause/resume and reflects the interactions toggle', () => {
    const m = trayMenuModel({ ...base, hidden: true, paused: true, interactionsEnabled: false });
    expect(actions(m).slice(0, 2)).toEqual(['show', 'resume']);
    const toggle = m.find((i) => i.kind === 'checkbox');
    expect(toggle && toggle.kind === 'checkbox' ? toggle.checked : null).toBe(false);
  });
});

describe('cat context menu', () => {
  it('offers wake instead of sleep while asleep and disables actions while paused', () => {
    expect(actions(catContextMenuModel(base))).toEqual(['pet', 'callCat', 'play', 'sleep', 'startLaserMode', 'pauseEvents', 'pause', 'hide', 'settings', 'quit']);
    expect(actions(catContextMenuModel({ ...base, state: 'sleeping' }))).toContain('wake');
    const paused = catContextMenuModel({ ...base, paused: true });
    const pet = paused.find((i) => i.kind === 'item' && i.action === 'pet');
    expect(pet && pet.kind === 'item' ? pet.enabled : null).toBe(false);
    expect(actions(paused)).toContain('resume');
  });
});

describe('product name in menus (ADR 0004 §9)', () => {
  const label = (items: MenuItemModel[], action: string): string | null => {
    const found = items.find((i) => i.kind !== 'separator' && i.action === action);
    return found && found.kind !== 'separator' ? found.label : null;
  };

  it('the tray menu and the cat menu quit GizeCat', () => {
    expect(label(trayMenuModel(base), 'quit')).toBe('Quit GizeCat');
    expect(label(catContextMenuModel(base), 'quit')).toBe('Quit GizeCat');
  });
});

describe('tray tooltip and icon', () => {
  it('describes state and vision mode', () => {
    expect(trayTooltip(base)).toBe('GizeCat — idle · Vision: off');
    expect(trayTooltip({ ...base, state: 'chasingCursor', perceptionMode: 'local-stats' })).toBe('GizeCat — chasing the cursor · Vision: local stats');
    expect(trayTooltip({ ...base, hidden: true, perceptionMode: 'ai-local', perceptionPaused: true })).toBe('GizeCat — hidden · Vision: AI (local) (paused)');
    expect(trayTooltip({ ...base, paused: true })).toContain('paused');
    expect(trayTooltip(base).length).toBeLessThanOrEqual(127);
  });

  it('picks the icon variant', () => {
    expect(trayIconVariant(base)).toBe('tray');
    expect(trayIconVariant({ ...base, perceptionMode: 'ai-local' })).toBe('tray-vision');
    expect(trayIconVariant({ ...base, perceptionMode: 'ai-local', perceptionPaused: true })).toBe('tray');
    expect(trayIconVariant({ ...base, paused: true, perceptionMode: 'ai-local' })).toBe('tray-paused');
  });

  it('draws a fallback bitmap with transparent corners and an opaque head', () => {
    const buf = drawTrayBitmap('tray', 32);
    expect(buf.length).toBe(32 * 32 * 4);
    expect(buf[3]).toBe(0);
    const centre = (18 * 32 + 16) * 4;
    expect(buf[centre + 3]).toBe(255);
    expect(drawTrayBitmap('tray-paused', 32).equals(buf)).toBe(false);
  });
});
