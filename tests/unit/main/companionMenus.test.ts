// Living Companion menu items: the laser toggle and the world-event pause in the tray and the cat's
// right-click menu. Pure models, nothing mocked.
import { describe, expect, it } from 'vitest';
import { catContextMenuModel, trayMenuModel, type MenuContext, type MenuItemModel } from '../../../src/main/lifecycle/menuModel';

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

const find = (items: MenuItemModel[], action: string) => items.find((i) => i.kind === 'item' && i.action === action);
const enabled = (items: MenuItemModel[], action: string) => {
  const it = find(items, action);
  return it && it.kind === 'item' ? it.enabled : null;
};
const label = (items: MenuItemModel[], action: string) => {
  const it = find(items, action);
  return it && it.kind === 'item' ? it.label : null;
};

describe('Living Companion menu items', () => {
  it('toggles one laser item between "Laser mode" and "Stop laser mode" in the tray and the cat menu', () => {
    for (const model of [trayMenuModel, catContextMenuModel]) {
      const off = model(base);
      expect(label(off, 'startLaserMode')).toBe('Laser mode');
      expect(find(off, 'stopLaserMode')).toBeUndefined();
      const on = model({ ...base, laserActive: true });
      expect(label(on, 'stopLaserMode')).toBe('Stop laser mode');
      expect(find(on, 'startLaserMode')).toBeUndefined();
    }
  });

  it('always leaves the laser exit enabled, even for a paused or hidden cat', () => {
    expect(enabled(catContextMenuModel({ ...base, laserActive: true, paused: true }), 'stopLaserMode')).toBe(true);
    expect(enabled(trayMenuModel({ ...base, laserActive: true, hidden: true }), 'stopLaserMode')).toBe(true);
    // Starting it needs a cat that is on screen and not paused.
    expect(enabled(catContextMenuModel({ ...base, paused: true }), 'startLaserMode')).toBe(false);
    expect(enabled(trayMenuModel({ ...base, hidden: true }), 'startLaserMode')).toBe(false);
  });

  it('toggles Pause and Resume world events', () => {
    expect(label(trayMenuModel(base), 'pauseEvents')).toBe('Pause world events');
    expect(label(catContextMenuModel({ ...base, eventsPaused: true }), 'resumeEvents')).toBe('Resume world events');
    expect(find(trayMenuModel({ ...base, eventsPaused: true }), 'pauseEvents')).toBeUndefined();
    expect(enabled(trayMenuModel({ ...base, paused: true }), 'pauseEvents')).toBe(true);
  });
});
