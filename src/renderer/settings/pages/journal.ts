// Journal: a quiet list of memorable moments, newest first, with a switch to stop keeping it and a
// button to clear it. No streaks, totals for engagement or notifications: only the entries themselves.
// The entries arrive as content-free tokens (event id, outcome, time) and are turned into sentences here.
import { JOURNAL_MAX } from '../../../shared/companion';
import { journalRows, type JournalRow } from '../companionView';
import type { PageContext, PageView } from '../context';
import { button, group, nestedToggleRow, page, row, runAction, setNote } from '../controls';
import { confirmDanger } from '../dialog';
import { h, icon } from '../dom';
import { livePoll } from '../livePoll';
import { deviceWords, platformWording, S } from '../strings';

const J = S.journal;

/** The journal's own switch: companion.journal holds only `enabled`, sent whole. */
const JOURNAL_LEAF = {
  read: (v: unknown): boolean => (v !== null && typeof v === 'object' ? (v as { enabled?: unknown }).enabled !== false : true),
  write: (cur: unknown, on: boolean): unknown => ({ ...(cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? (cur) : {}), enabled: on }),
};

function entryItem(r: JournalRow): HTMLElement {
  return h('li', { class: 'journal-entry' }, [
    h('time', { class: 'journal-date', datetime: r.iso, text: r.date }),
    h('span', { class: 'journal-text' }, [h('span', { class: 'journal-event', text: r.event }), h('span', { class: 'journal-sentence', text: r.text })]),
  ]);
}

export function journalPage(ctx: PageContext): PageView {
  const wording = platformWording(ctx.store.view.status.platform);
  const enabled = nestedToggleRow(ctx, 'companion', 'journal', JOURNAL_LEAF, { title: J.enabledTitle, desc: J.enabledDesc, icon: 'history' });

  // The list and its states live in one block; its note is the page's live region for load problems.
  const count = h('p', { class: 'muted journal-count' });
  const list = h('ol', { class: 'journal-list', 'aria-label': J.groupEntries });
  const empty = h('p', { class: 'muted', text: J.empty, hidden: true });
  const problem = h('div', { class: 'row-note', 'aria-live': 'polite', hidden: true });
  const block = h('div', { class: 'row row-block' }, [count, empty, list, problem]);

  const clear = row({ title: J.clearTitle, desc: J.clearDesc, icon: 'delete' });
  const clearBtn = button(J.clearButton, { variant: 'danger' });
  clear.control.append(clearBtn);

  const element = page(J.title, [
    h('p', { class: 'page-note' }, [icon('info'), h('span', { text: deviceWords(J.intro, wording) })]),
    group(J.groupSettings, [enabled.parts.row, clear.row]),
    group(J.groupEntries, [block]),
  ]);

  let rows: JournalRow[] = [];
  let loaded = false;
  let epoch = 0;
  let shownProblem: string | null = null;
  /** Shows a problem once: the poll retries every few seconds and must not re-announce it each time. */
  const showProblem = (text: string | null): void => {
    if (text === shownProblem) return;
    shownProblem = text;
    setNote(problem, text, 'warn');
  };
  const render = (): void => {
    const journalOn = ctx.store.intended('companion', 'journal')?.enabled !== false;
    list.replaceChildren(...rows.map(entryItem));
    list.hidden = rows.length === 0;
    empty.hidden = rows.length > 0 || !loaded;
    empty.textContent = journalOn ? J.empty : J.emptyOff;
    count.hidden = rows.length === 0;
    count.textContent = J.count(rows.length, JOURNAL_MAX);
    clearBtn.disabled = rows.length === 0;
  };

  /** Reads the journal from main. A reply that arrives after the page was left or cleared is dropped. */
  const load = async (): Promise<void> => {
    const mine = ++epoch;
    try {
      const entries = await ctx.api.getJournal();
      if (mine !== epoch) return;
      rows = journalRows(entries);
      loaded = true;
      showProblem(null);
    } catch {
      if (mine !== epoch) return;
      // An older main has no journal call (or it failed): keep what is shown and say so once.
      loaded = true;
      showProblem(typeof ctx.api.getJournal === 'function' ? J.loadFailed : J.unavailable);
    }
    render();
  };

  clearBtn.addEventListener('click', () => {
    void (async () => {
      if (!(await confirmDanger(J.clearConfirmTitle, deviceWords(J.clearConfirmText, wording), J.clearButton))) return;
      epoch += 1; // anything still in flight predates the clear
      const ok = await runAction(ctx, 'clearJournal', clearBtn, clear.note, J.clearDone);
      if (ok) {
        rows = [];
        loaded = true;
        render();
      } else {
        await load();
      }
    })();
  });

  ctx.store.subscribe(render);
  // New entries appear without a broadcast from main, so the list is re-read while the page is shown.
  const poll = livePoll({
    timers: ctx.timers,
    refresh: load,
    isVisible: () => !element.hidden && document.visibilityState !== 'hidden',
  });
  return {
    id: 'journal',
    title: J.title,
    element,
    onShow() {
      render();
      poll.start();
    },
    onHide() {
      epoch += 1;
      poll.stop();
    },
  };
}
