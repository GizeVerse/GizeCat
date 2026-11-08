// Entry point of the settings renderer (sandboxed; talks to main only through
// window.desktopCatSettings, exposed by src/preload/settings.ts).
import type { SettingsApi } from '../../shared/ipc';
import { mountApp } from './app';
import { button } from './controls';
import { h, icon } from './dom';
import { errorText } from './store';
import { S } from './strings';

declare global {
  interface Window {
    desktopCatSettings?: SettingsApi;
  }
}

function message(root: HTMLElement, text: string, retry?: () => void): void {
  // 1.4.0: the Segoe icon fonts exist on Windows only, and main's platform report has not arrived yet.
  const glyphs = navigator.userAgent.includes('Windows') ? [icon(retry ? 'error' : 'info', 'boot-icon')] : [];
  const children: HTMLElement[] = [...glyphs, h('p', { class: 'boot-text', text })];
  if (retry) {
    const btn = button(S.app.retry, { variant: 'accent' });
    btn.addEventListener('click', retry);
    children.push(btn);
  }
  root.replaceChildren(h('div', { class: 'boot', role: retry ? 'alert' : 'status' }, children));
}

async function boot(root: HTMLElement): Promise<void> {
  document.title = S.app.title;
  const api = window.desktopCatSettings;
  if (!api) {
    message(root, navigator.userAgent.includes('Macintosh') ? S.app.bridgeMissingMac : S.app.bridgeMissing);
    return;
  }
  root.setAttribute('aria-busy', 'true');
  message(root, S.app.loading);
  try {
    const view = await api.getState();
    mountApp(root, api, view);
  } catch (e) {
    root.removeAttribute('aria-busy');
    message(root, S.app.loadFailed(errorText(e)), () => void boot(root));
  }
}

const root = document.getElementById('app');
if (root) void boot(root);
