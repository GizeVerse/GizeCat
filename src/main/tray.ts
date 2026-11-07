// Notification-area icon. Windows convention: left click performs the primary
// action (show/hide the cat), right click opens the context menu.
// macOS (1.4.0, decision D5): a template menu-bar icon, and a click only opens the menu. Electron
// 44 emits 'click' and then opens the context menu on the same mouse-down (tray_icon_cocoa.mm), so
// a click toggle there would hide or show the cat every time the menu is opened; Show/Hide is a
// menu item instead (clickToggles: false).
import path from 'node:path';
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { BRAND } from '../shared/brand';
import type { Logger } from './contracts';
import type { NoticeHandlers, NoticeSurface } from './lifecycle/loginItemNotice';
import { trayMenuModel, trayTooltip, trayIconVariant, type MenuAction, type MenuContext, type MenuItemModel, type TrayIconVariant } from './lifecycle/menuModel';
import { drawTrayBitmap, drawTrayTemplateBitmap } from './lifecycle/trayIcon';

export interface TrayController extends NoticeSurface {
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
  /** Balloon notices exist on Windows only (ADR 0004 §3); elsewhere notify() reports false. */
  balloons?: boolean;
  /**
   * macOS: template images (black plus alpha, tinted by the system for light, dark and tinted menu
   * bars): `<variant>Template.png` from iconDir when present, else drawTrayTemplateBitmap.
   */
  template?: boolean;
  /** A left click runs onClick (default true). False on macOS, where a click opens the menu. */
  clickToggles?: boolean;
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

  /** macOS: a template image. No asset ships for it yet, so the generated one is the normal case (no warning). */
  function templateIcon(variant: TrayIconVariant): NativeImage {
    let img = nativeImage.createFromPath(path.join(opts.iconDir, `${variant}Template.png`));
    if (img.isEmpty()) img = nativeImage.createFromBitmap(drawTrayTemplateBitmap(variant, 32), { width: 32, height: 32, scaleFactor: 2 });
    img.setTemplateImage(true);
    return img;
  }

  function icon(variant: TrayIconVariant): NativeImage {
    const cached = icons.get(variant);
    if (cached) return cached;
    let img: NativeImage;
    if (opts.template) {
      img = templateIcon(variant);
    } else {
      img = nativeImage.createFromPath(path.join(opts.iconDir, `${variant}.png`));
      if (img.isEmpty()) {
        log.warn('tray icon asset missing; using generated icon', { variant });
        img = nativeImage.createFromBitmap(drawTrayBitmap(variant, 32), { width: 32, height: 32, scaleFactor: 2 });
      }
    }
    icons.set(variant, img);
    return img;
  }

  const tray = new Tray(icon('tray'));
  tray.setToolTip(BRAND.product);
  if (opts.clickToggles !== false) {
    tray.on('click', () => {
      try {
        opts.onClick();
      } catch (err) {
        log.error('tray click failed', { error: err });
      }
    });
  }

  let menuKey = '';
  let tooltip = '';
  let variant: TrayIconVariant = 'tray';
  let disposed = false;

  // Windows shows a tray balloon as a toast; its events reach the handlers of the latest one.
  let balloon: NoticeHandlers | null = null;
  const onBalloon = (what: string, fn: (h: NoticeHandlers) => void) => () => {
    const h = balloon;
    if (!h) return;
    try {
      fn(h);
    } catch (err) {
      log.error(`tray notification ${what} handler failed`, { error: err });
    }
  };
  tray.on('balloon-show', onBalloon('show', (h) => h.onShown()));
  tray.on('balloon-click', onBalloon('click', (h) => h.onClick()));

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
    notify(notice, handlers) {
      if (disposed || tray.isDestroyed() || opts.balloons === false) return false;
      balloon = handlers;
      // Quiet time and Do not disturb suppress it; the handlers then never run.
      tray.displayBalloon({ title: notice.title, content: notice.body, icon: icon('tray'), respectQuietTime: true });
      return true;
    },
    dispose() {
      disposed = true;
      balloon = null;
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
