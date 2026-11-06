// macOS application menu (ADR 0004 §6). Without one, macOS routes no Cmd+C/V/X/A/Z to text
// fields, so the Settings window's inputs could not be edited with the keyboard shortcuts.
// Roles only: no custom handlers, no key listeners of our own.
import type { MenuItemConstructorOptions } from 'electron';

export function darwinApplicationMenu(): MenuItemConstructorOptions[] {
  return [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
}
