// macOS application menu (ADR 0004 §6). Without one, macOS routes no Cmd+C/V/X/A/Z to text
// fields, so the Settings window's inputs could not be edited with the keyboard shortcuts.
// Roles only: no custom handlers, no key listeners of our own.
//
// 1.4.0 (decision D8): an explicit app submenu instead of the 'appMenu' role. That role includes
// Hide (Cmd+H), and NSApp hide orders out every window of the app, the overlays included, while the
// cat's visibility is app state (show/hide in the tray menu) and overlays are never hidden
// (Electron transparent-window bugs). So there is no 'hide' item. Pure: the name is a parameter.
import type { MenuItemConstructorOptions } from 'electron';

export function darwinApplicationMenu(appName: string): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `About ${appName}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${appName}` },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
}
