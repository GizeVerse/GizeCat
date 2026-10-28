// Window shell: navigation rail, page switching (hash-based so a page can be
// deep-linked, e.g. settings/index.html#privacy) and state wiring.
import type { SettingsApi, SettingsViewState } from '../../shared/ipc';
import { isPageId, PAGE_IDS, type PageId } from './catalog';
import type { PageContext, PageView } from './context';
import { h, icon, type GlyphName } from './dom';
import { aboutPage } from './pages/about';
import { aiPage } from './pages/ai';
import { appearancePage } from './pages/appearance';
import { behaviorPage } from './pages/behavior';
import { diagnosticsPage } from './pages/diagnostics';
import { generalPage } from './pages/general';
import { interactionPage } from './pages/interaction';
import { personalityPage } from './pages/personality';
import { privacyPage } from './pages/privacy';
import { welcomePage } from './pages/welcome';
import { brandMark } from './skins';
import { SettingsStore, type Timers } from './store';
import { S } from './strings';

const NAV_ICONS: Record<PageId, GlyphName> = {
  welcome: 'home',
  general: 'settings',
  appearance: 'color',
  behavior: 'behavior',
  interaction: 'touch',
  privacy: 'shield',
  ai: 'robot',
  personality: 'heart',
  diagnostics: 'diagnostic',
  about: 'info',
};

const FACTORIES: Record<PageId, (ctx: PageContext) => PageView> = {
  welcome: welcomePage,
  general: generalPage,
  appearance: appearancePage,
  behavior: behaviorPage,
  interaction: interactionPage,
  privacy: privacyPage,
  ai: aiPage,
  personality: personalityPage,
  diagnostics: diagnosticsPage,
  about: aboutPage,
};

const browserTimers: Timers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export function mountApp(root: HTMLElement, api: SettingsApi, initial: SettingsViewState): () => void {
  const store = new SettingsStore(api, initial, browserTimers);
  let current: PageId | null = null;
  const pages = new Map<PageId, PageView>();
  const navButtons = new Map<PageId, HTMLButtonElement>();
  const content = h('main', { class: 'content', id: 'content' });

  const ctx: PageContext = {
    api,
    store,
    timers: browserTimers,
    now: () => Date.now(),
    navigate: (id) => show(id, true),
    refresh: async () => store.receive(await api.getState()),
  };

  const navList = h('ul', { class: 'nav-list' });
  for (const id of PAGE_IDS) {
    const btn = h('button', { type: 'button', class: 'nav-item', 'data-page': id }, [icon(NAV_ICONS[id], 'nav-icon'), h('span', { class: 'nav-label', text: S.nav[id] })]);
    btn.addEventListener('click', () => show(id, true));
    btn.addEventListener('keydown', (e) => {
      const i = PAGE_IDS.indexOf(id);
      let target: PageId | undefined;
      if (e.key === 'ArrowDown') target = PAGE_IDS[(i + 1) % PAGE_IDS.length];
      else if (e.key === 'ArrowUp') target = PAGE_IDS[(i - 1 + PAGE_IDS.length) % PAGE_IDS.length];
      else if (e.key === 'Home') target = PAGE_IDS[0];
      else if (e.key === 'End') target = PAGE_IDS[PAGE_IDS.length - 1];
      if (!target) return;
      e.preventDefault();
      navButtons.get(target)?.focus();
    });
    navButtons.set(id, btn);
    navList.append(h('li', {}, [btn]));
  }
  const nav = h('nav', { class: 'rail', 'aria-label': S.app.navLabel }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, [brandMark()]), h('span', { class: 'brand-name', text: S.app.brand })]),
    navList,
  ]);

  for (const id of PAGE_IDS) {
    const view = FACTORIES[id](ctx);
    pages.set(id, view);
    content.append(view.element);
  }

  function show(id: PageId, fromUser: boolean): void {
    if (current === id) return;
    const previous = current === null ? undefined : pages.get(current);
    current = id;
    for (const [pid, view] of pages) view.element.hidden = pid !== id;
    previous?.onHide?.();
    for (const [pid, btn] of navButtons) {
      if (pid === id) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
    const view = pages.get(id);
    document.title = S.app.pageTitle(view?.title ?? S.app.title);
    content.scrollTop = 0;
    view?.onShow?.();
    if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
    if (fromUser && document.activeElement && !nav.contains(document.activeElement)) {
      view?.element.querySelector<HTMLElement>('.page-title')?.focus();
    }
  }

  const fromHash = (): PageId | null => {
    const id = location.hash.replace(/^#/, '');
    return isPageId(id) ? id : null;
  };
  const onHash = (): void => {
    const id = fromHash();
    if (id) show(id, false);
  };
  window.addEventListener('hashchange', onHash);

  const unsubscribe = api.onStateChanged((view) => store.receive(view));
  const flushOnHide = (): void => {
    if (document.visibilityState === 'hidden') void store.flush();
  };
  document.addEventListener('visibilitychange', flushOnHide);

  root.replaceChildren(h('div', { class: 'app' }, [nav, content]));
  root.removeAttribute('aria-busy');
  show(fromHash() ?? (initial.settings.general.firstRunCompleted ? 'general' : 'welcome'), false);

  return () => {
    if (current !== null) pages.get(current)?.onHide?.();
    unsubscribe();
    window.removeEventListener('hashchange', onHash);
    document.removeEventListener('visibilitychange', flushOnHide);
  };
}
