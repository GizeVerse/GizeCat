// Notification-area icon. Windows convention: left click performs the primary
// action (show/hide the cat), right click opens the context menu.
import path from 'node:path';
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import type { Logger } from './contracts';
import { trayMenuModel, trayTooltip, trayIconVariant, type MenuAction, type MenuContext, type MenuItemModel, type TrayIconVariant } from './lifecycle/menuModel';
import { drawTrayBitmap } from './lifecycle/trayIcon';

export interface TrayController {
  update(ctx: MenuContext): void;
  dispose(): void;
}

export interface TrayOptions {
  /** Directory with tray.png / tray-paused.png / tray-vision.png (+ @2x variants). */
  iconDir: string;
  logger: Logger;
  onAction: (action: MenuAction) => void;
  /** Left click. */
  onClick: () => void;
}

export function toMenuTemplate(items: readonly MenuItemModel[], onAction: (a: MenuAction) => void): MenuItemConstructorOptions[] {
  return items.map((it): MenuItemConstructorOptions => {
    if (it.kind === 'separator') return { type: 'separator' };
    const base = { label: it.label, enabled: it.enabled, click: () => onAction(it.action) };
    return it.kind === 'checkbox' ? { ...base, type: 'checkbox', checked: it.checked } : base;
  });
}

export function createTrayController(opts: TrayOptions): TrayController {
  const log = opts.logger;
  const icons = new Map<TrayIconVariant, NativeImage>();

  function icon(variant: TrayIconVariant): NativeImage {
    const cached = icons.get(variant);
    if (cached) return cached;
    let img = nativeImage.createFromPath(path.join(opts.iconDir, `${variant}.png`));
    if (img.isEmpty()) {
      log.warn('tray icon asset missing; using generated icon', { variant });
      img = nativeImage.createFromBitmap(drawTrayBitmap(variant, 32), { width: 32, height: 32, scaleFactor: 2 });
    }
    icons.set(variant, img);
    return img;
  }

  const tray = new Tray(icon('tray'));
  tray.setToolTip('Desktop Cat');
  tray.on('click', () => {
    try {
      opts.onClick();
    } catch (err) {
      log.error('tray click failed', { error: err });
    }
  });

  let menuKey = '';
  let tooltip = '';
  let variant: TrayIconVariant = 'tray';
  let disposed = false;

  return {
    update(ctx) {
      if (disposed || tray.isDestroyed()) return;
      const model = trayMenuModel(ctx);
      const key = JSON.stringify(model);
      // Rebuild only on menu changes so an open menu is not replaced by a tooltip update.
      if (key !== menuKey) {
        menuKey = key;
        tray.setContextMenu(Menu.buildFromTemplate(toMenuTemplate(model, opts.onAction)));
      }
      const tip = trayTooltip(ctx);
      if (tip !== tooltip) {
        tooltip = tip;
        tray.setToolTip(tip);
      }
      const v = trayIconVariant(ctx);
      if (v !== variant) {
        variant = v;
        tray.setImage(icon(v));
      }
    },
    dispose() {
      disposed = true;
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
