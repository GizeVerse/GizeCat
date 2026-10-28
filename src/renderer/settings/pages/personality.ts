import type { CatSummary, Counters, Preferences, Stats, Traits } from '../../../shared/catState';
import type { SettingsAction } from '../../../shared/ipc';
import type { PageContext, PageView } from '../context';
import { button, group, meter, page, row, runAction, type RowParts } from '../controls';
import { confirmDanger } from '../dialog';
import { h, icon } from '../dom';
import { behaviorStateLabel, formatAge, formatCount, formatDecimal, formatPercent, formatRelativeTime, memoryKindLabel } from '../format';
import { coatArt } from '../skins';
import { S } from '../strings';

const P = S.personality;
const RELATIVE_REFRESH_MS = 30_000;

const keysOf = <T extends object>(labels: Record<keyof T, string>): Array<keyof T> => Object.keys(labels) as Array<keyof T>;

function meters<T extends object>(values: T, labels: Record<keyof T, string>): HTMLElement[] {
  return keysOf<T>(labels).map((k) => {
    const v = values[k];
    const n = typeof v === 'number' ? v : 0;
    return meter(labels[k], n, formatPercent(n));
  });
}

function counterGrid(counters: Counters): HTMLElement {
  return h(
    'dl',
    { class: 'stat-grid' },
    keysOf<Counters>(P.counters).map((k) => h('div', { class: 'stat' }, [h('dt', { text: P.counters[k] }), h('dd', { text: formatCount(counters[k]) })])),
  );
}

function learned(prefs: Preferences): HTMLElement[] {
  return [
    h('div', { class: 'meter-row' }, [
      h('span', { class: 'meter-label', text: P.preferences.petRatePerHour }),
      h('span', { class: 'meter-spacer' }),
      h('span', { class: 'meter-value', text: formatDecimal(prefs.petRatePerHour, 1) }),
    ]),
    meter(P.preferences.cursorPlayAcceptance, prefs.cursorPlayAcceptance, formatPercent(prefs.cursorPlayAcceptance)),
    meter(P.preferences.attentionAcceptance, prefs.attentionAcceptance, formatPercent(prefs.attentionAcceptance)),
  ];
}

function memories(cat: CatSummary, now: number): HTMLElement {
  if (cat.recent.length === 0) return h('p', { class: 'muted', text: P.noMemories });
  const sorted = [...cat.recent].sort((a, b) => b.at - a.at);
  return h(
    'ol',
    { class: 'timeline' },
    sorted.map((m) =>
      h('li', { class: 'timeline-item' }, [
        h('span', { class: 'timeline-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'timeline-kind', text: memoryKindLabel(m.kind) }),
        m.detail ? h('span', { class: 'timeline-detail', text: m.detail }) : null,
        h('time', { class: 'timeline-time', datetime: new Date(m.at).toISOString(), text: formatRelativeTime(m.at, now) }),
      ]),
    ),
  );
}

function card(children: HTMLElement[]): HTMLElement {
  return h('div', { class: 'row row-block' }, children);
}

function dangerRow(ctx: PageContext, title: string, desc: string, label: string, confirmTitle: string, confirmText: string, action: SettingsAction, done: string): RowParts {
  const parts = row({ title, desc, icon: 'delete' });
  const btn = button(label, { variant: 'danger' });
  parts.control.append(btn);
  btn.addEventListener('click', () => {
    void (async () => {
      if (await confirmDanger(confirmTitle, confirmText, label)) await runAction(ctx, action, btn, parts.note, done);
    })();
  });
  return parts;
}

export function personalityPage(ctx: PageContext): PageView {
  const art = h('div', { class: 'profile-art', 'aria-hidden': 'true' });
  const name = h('h2', { class: 'profile-name' });
  const since = h('div', { class: 'profile-line' });
  const state = h('div', { class: 'profile-line' });
  const spots = h('div', { class: 'profile-line' });
  const profile = h('div', { class: 'profile' }, [art, h('div', { class: 'profile-text' }, [name, state, since, spots])]);
  const traits = card([]);
  const stats = card([]);
  const prefs = card([]);
  const counters = card([]);
  const recent = card([]);
  const reset = dangerRow(ctx, P.resetTitle, P.resetDesc, P.resetButton, P.resetConfirmTitle, P.resetConfirmText, 'resetPersonality', P.resetDone);
  const clear = dangerRow(ctx, P.clearTitle, P.clearDesc, P.clearButton, P.clearConfirmTitle, P.clearConfirmText, 'clearHistory', P.clearDone);

  const element = page(P.title, [
    profile,
    h('p', { class: 'page-note' }, [icon('info'), h('span', { text: P.simulationNote })]),
    group(P.groupTraits, [traits]),
    group(P.groupStats, [stats]),
    group(P.groupLearned, [prefs]),
    group(P.groupCounters, [counters]),
    group(P.groupMemories, [recent]),
    group(P.groupReset, [reset.row, clear.row]),
  ]);

  let skin = '';
  const render = (): void => {
    const view = ctx.store.view;
    const cat = view.cat;
    const now = ctx.now();
    if (skin !== view.settings.appearance.skin) {
      skin = view.settings.appearance.skin;
      art.replaceChildren(coatArt(view.settings.appearance.skin));
    }
    name.textContent = cat.name;
    state.textContent = P.stateNow(behaviorStateLabel(cat.state));
    since.textContent = P.livingSince(formatAge(cat.bornAt, now));
    spots.textContent = P.favoriteSpots(cat.favoriteSpotCount);
    traits.replaceChildren(...meters<Traits>(cat.traits, P.traits));
    stats.replaceChildren(...meters<Stats>(cat.stats, P.stats));
    prefs.replaceChildren(...learned(cat.preferences));
    counters.replaceChildren(counterGrid(cat.counters));
    recent.replaceChildren(memories(cat, now));
  };
  ctx.store.subscribe(render);
  let timer: number | null = null;
  return {
    id: 'personality',
    title: P.title,
    element,
    onShow() {
      render();
      if (timer === null) {
        timer = window.setInterval(() => {
          if (!element.hidden) render();
        }, RELATIVE_REFRESH_MS);
      }
    },
  };
}
