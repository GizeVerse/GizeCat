// Companion: how the cat is right now (live status from main) and the things you do to the running
// cat: call it, show or hide it, pause it, laser mode and pausing world events. Starting and quitting
// is the app itself (General). Everything tolerates a view state from an older build without `companion`.
import type { CompanionStatus } from '../../../shared/ipc';
import { callRow, keepInSync, pauseRow, visibilityRow } from '../companionControls';
import { moodLabel, pauseEventsNote, personalityLine, readEvents, worldEventLine } from '../companionView';
import type { PageContext, PageView } from '../context';
import { button, group, keyValues, page, row, runAction, setButtonLabel, setNote } from '../controls';
import { h, icon } from '../dom';
import { behaviorStateLabel } from '../format';
import { pagePoll } from '../livePoll';
import { S } from '../strings';

const C = S.companion;
const G = S.general;

/** Sets text only when it changed, so a live region is not re-announced by every refresh. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function companionPage(ctx: PageContext): PageView {
  const intro = h('p', { class: 'page-note' }, [icon('info'), h('span', { text: C.intro })]);

  // ---- live status --------------------------------------------------------------------------
  const moodValue = h('span');
  const activityValue = h('span');
  const personalityValue = h('span');
  const worldValue = h('span');
  const statusList = keyValues([
    [C.moodTitle, moodValue],
    [C.activityTitle, activityValue],
    [C.personalityTitle, personalityValue],
    [C.worldTitle, worldValue],
  ]);
  const unavailable = h('p', { class: 'muted', text: C.statusUnavailable, hidden: true });
  const autoNote = h('p', { class: 'muted', text: C.personalityAutoNote, hidden: true });
  // The only live region of the status: it speaks when the mood or the world event changes, not on
  // every refresh, and never for the countdown.
  const announcer = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const statusBlock = h('div', { class: 'row row-block' }, [statusList, unavailable, autoNote, announcer]);

  // ---- rows that act on the cat -------------------------------------------------------------
  const call = callRow(ctx);
  const visibility = visibilityRow(ctx);
  const pause = pauseRow(ctx, { title: G.pauseTitle, desc: G.pauseDesc, pause: G.pause, resume: G.resume, pausedNow: G.pausedNow });
  keepInSync(ctx, [call, visibility, pause]);

  const laser = row({ title: C.laserTitle, desc: C.laserDesc, icon: 'mouse' });
  const laserBtn = button(C.laserStart);
  laser.control.append(laserBtn);
  setNote(laser.note, C.laserLearnMore, 'info');
  laserBtn.addEventListener('click', () => {
    const on = ctx.store.view.companion?.laserActive === true;
    void runAction(ctx, on ? 'stopLaserMode' : 'startLaserMode', laserBtn, laser.error);
  });

  const events = row({ title: C.pauseEventsTitle, desc: C.pauseEventsDesc, icon: 'clock' });
  const eventsBtn = button(C.pauseEvents);
  events.control.append(eventsBtn);
  eventsBtn.addEventListener('click', () => {
    const paused = ctx.store.view.companion?.eventsPaused === true;
    void runAction(ctx, paused ? 'resumeEvents' : 'pauseEvents', eventsBtn, events.error);
  });

  const element = page(C.title, [
    intro,
    group(C.groupStatus, [statusBlock]),
    group(C.groupCat, [call.parts.row, visibility.parts.row, pause.parts.row]),
    group(C.groupWorld, [laser.row, events.row]),
  ]);

  let announced: string | null = null;
  const render = (): void => {
    const view = ctx.store.view;
    const c: CompanionStatus | undefined = view.companion;
    const eventsEnabled = readEvents(view.settings.companion?.events).enabled;
    unavailable.hidden = c !== undefined;
    autoNote.hidden = !(c?.personalityIsAuto === true);
    laserBtn.disabled = c === undefined;
    eventsBtn.disabled = c === undefined || (!eventsEnabled && !c.eventsPaused);
    if (!c) {
      for (const el of [moodValue, activityValue, personalityValue, worldValue]) setText(el, S.common.notAvailable);
      setButtonLabel(laserBtn, C.laserStart);
      setButtonLabel(eventsBtn, C.pauseEvents);
      return;
    }
    const mood = moodLabel(c.mood);
    setText(moodValue, mood);
    setText(activityValue, behaviorStateLabel(c.activity));
    setText(personalityValue, personalityLine(c));
    setText(worldValue, worldEventLine(c, eventsEnabled));
    setButtonLabel(laserBtn, c.laserActive ? C.laserStop : C.laserStart);
    setNote(laser.note, c.laserActive ? C.laserOn : C.laserLearnMore, 'info');
    setButtonLabel(eventsBtn, c.eventsPaused ? C.resumeEvents : C.pauseEvents);
    setNote(events.note, pauseEventsNote(c, eventsEnabled), 'info');
    const key = `${c.mood}|${c.event ?? ''}`;
    if (announced !== null && announced !== key) {
      const running = c.event !== null ? ` ${worldEventLine(c, eventsEnabled)}.` : '';
      setText(announcer, `${C.announce(mood, behaviorStateLabel(c.activity))}${running}`);
    }
    announced = key;
  };
  ctx.store.subscribe(render);

  // Mood, activity and the countdown move without a broadcast from main, so the view is re-read while shown.
  const poll = pagePoll(ctx, element);
  return {
    id: 'companion',
    title: C.title,
    element,
    onShow() {
      render();
      poll.start();
    },
    onHide: () => poll.stop(),
  };
}
