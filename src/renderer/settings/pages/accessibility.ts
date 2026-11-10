// Accessibility & Focus: calmer motion, and every way of making the cat quiet or absent while you
// concentrate. Each control here is the same setting or action as elsewhere (Behaviour, Companion), shown
// with the words of this page, so changing it in either place agrees.
import { keepInSync, pauseRow } from '../companionControls';
import { eventsWith, readEvents } from '../companionView';
import type { PageContext, PageView } from '../context';
import { group, nestedToggleRow, page, toggleRow } from '../controls';
import { h, icon } from '../dom';
import { S } from '../strings';
import { fullscreenControl } from './behavior';

const X = S.access;

export function accessibilityPage(ctx: PageContext): PageView {
  const reduced = toggleRow(ctx, 'companion', 'reducedMotion', { title: X.reducedTitle, desc: X.reducedDesc, icon: 'view' });
  const pause = pauseRow(ctx, { title: X.pauseTitle, desc: X.pauseDesc, pause: X.pauseButton, resume: X.resumeButton, pausedNow: X.pausedNow });
  keepInSync(ctx, [pause]);
  // The inverse of World events (companion.events.enabled): on here means events are off.
  const eventsOff = nestedToggleRow(
    ctx,
    'companion',
    'events',
    { read: (v) => !readEvents(v).enabled, write: (cur, on) => eventsWith(cur, { enabled: !on }) },
    { title: X.eventsOffTitle, desc: X.eventsOffDesc, icon: 'hide' },
  );
  const fullscreen = fullscreenControl(ctx, { title: X.fullscreenTitle, desc: X.fullscreenDesc });

  const element = page(X.title, [
    h('p', { class: 'page-note' }, [icon('info'), h('span', { text: X.intro })]),
    group(X.groupMotion, [reduced.parts.row]),
    group(X.groupFocus, [pause.parts.row, eventsOff.parts.row, fullscreen.row]),
    h('p', { class: 'page-note' }, [icon('info'), h('span', { text: X.fullscreenNote })]),
    h('p', { class: 'page-note' }, [icon('info'), h('span', { text: X.clickThroughNote })]),
  ]);

  return { id: 'accessibility', title: X.title, element, onShow: () => fullscreen.sync() };
}
