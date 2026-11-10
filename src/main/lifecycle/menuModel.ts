// Pure descriptions of the tray menu, tray tooltip/icon and the cat's right-click
// menu. tray.ts and the overlay manager turn these into native menus.
import { BRAND } from '../../shared/brand';
import type { BehaviorState } from '../../shared/cat';
import type { PerceptionMode } from '../../shared/perception';

const QUIT_LABEL = `Quit ${BRAND.product}`;

export type MenuAction =
  | 'pet'
  | 'callCat'
  | 'play'
  | 'sleep'
  | 'wake'
  | 'pause'
  | 'resume'
  | 'hide'
  | 'show'
  | 'toggleInteractions'
  | 'privacyPause'
  | 'privacyResume'
  | 'startLaserMode'
  | 'stopLaserMode'
  | 'pauseEvents'
  | 'resumeEvents'
  | 'settings'
  | 'quit';

export type MenuItemModel =
  | { kind: 'separator' }
  | { kind: 'item'; action: MenuAction; label: string; enabled: boolean }
  | { kind: 'checkbox'; action: MenuAction; label: string; checked: boolean; enabled: boolean };

export interface MenuContext {
  catName: string;
  hidden: boolean;
  paused: boolean;
  state: BehaviorState;
  interactionsEnabled: boolean;
  /** settings.perception.visualMode !== 'off' */
  perceptionConfigured: boolean;
  perceptionPaused: boolean;
  perceptionMode: PerceptionMode;
  /** Living Companion Laser Mode is on (session-only). Absent = off. */
  laserActive?: boolean;
  /** The user paused world events for this session. Absent = not paused. */
  eventsPaused?: boolean;
}

const SLEEPY: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['sleeping', 'fallingAsleep']);

export const VISION_LABEL: Record<PerceptionMode, string> = {
  off: 'off',
  'local-stats': 'local stats',
  'ai-local': 'AI (local)',
  'ai-cloud': 'AI (cloud)',
};

const STATE_LABEL: Partial<Record<BehaviorState, string>> = {
  sleeping: 'sleeping',
  fallingAsleep: 'getting sleepy',
  wakingUp: 'waking up',
  chasingCursor: 'chasing the cursor',
  watchingCursor: 'watching the cursor',
  inspectingWindow: 'inspecting a window',
  watchingUser: 'watching you',
  beingPetted: 'being petted',
  seekingAttention: 'wants attention',
  held: 'being carried',
  away: 'away',
};

export function describeState(state: BehaviorState): string {
  return STATE_LABEL[state] ?? state.replace(/([A-Z])/g, ' $1').toLowerCase();
}

function item(action: MenuAction, label: string, enabled = true): MenuItemModel {
  return { kind: 'item', action, label, enabled };
}

/** One toggling item: 'Laser mode' to start, 'Stop laser mode' to leave (the tray is always a way out). */
function laserItem(ctx: MenuContext, enabledToStart: boolean): MenuItemModel {
  return ctx.laserActive === true ? item('stopLaserMode', 'Stop laser mode') : item('startLaserMode', 'Laser mode', enabledToStart);
}

function eventsItem(ctx: MenuContext): MenuItemModel {
  return ctx.eventsPaused === true ? item('resumeEvents', 'Resume world events') : item('pauseEvents', 'Pause world events');
}

export function trayMenuModel(ctx: MenuContext): MenuItemModel[] {
  const items: MenuItemModel[] = [
    item(ctx.hidden ? 'show' : 'hide', ctx.hidden ? `Show ${ctx.catName}` : `Hide ${ctx.catName}`),
    item(ctx.paused ? 'resume' : 'pause', ctx.paused ? 'Resume cat' : 'Pause cat', !ctx.hidden),
    { kind: 'checkbox', action: 'toggleInteractions', label: 'Interactions', checked: ctx.interactionsEnabled, enabled: true },
  ];
  if (ctx.perceptionConfigured) {
    const mode = VISION_LABEL[ctx.perceptionMode];
    items.push(
      ctx.perceptionPaused
        ? item('privacyResume', `Vision (${mode}): resume`)
        : item('privacyPause', `Vision (${mode}): privacy pause`),
    );
  }
  items.push(
    { kind: 'separator' },
    item('callCat', `Call ${ctx.catName}`, !ctx.paused),
    laserItem(ctx, !ctx.hidden && !ctx.paused),
    eventsItem(ctx),
    item('settings', 'Settings…'),
    { kind: 'separator' },
    item('quit', QUIT_LABEL),
  );
  return items;
}

export function catContextMenuModel(ctx: MenuContext): MenuItemModel[] {
  const asleep = SLEEPY.has(ctx.state);
  const active = !ctx.paused && !ctx.hidden;
  return [
    item('pet', `Pet ${ctx.catName}`, active && !asleep),
    item('callCat', 'Call to cursor', active),
    item('play', 'Play', active && !asleep),
    asleep ? item('wake', 'Wake up', active) : item('sleep', 'Go to sleep', active),
    // The laser exit is offered while Laser Mode is on, whatever the cat is doing.
    laserItem(ctx, active),
    eventsItem(ctx),
    { kind: 'separator' },
    item(ctx.paused ? 'resume' : 'pause', ctx.paused ? 'Resume' : 'Pause'),
    item('hide', 'Hide'),
    { kind: 'separator' },
    item('settings', 'Settings…'),
    item('quit', QUIT_LABEL),
  ];
}

export function trayTooltip(ctx: MenuContext): string {
  const state = ctx.hidden ? 'hidden' : ctx.paused ? 'paused' : describeState(ctx.state);
  let vision = VISION_LABEL[ctx.perceptionMode];
  if (ctx.perceptionMode !== 'off' && ctx.perceptionPaused) vision += ' (paused)';
  // Windows truncates notification-area tooltips at 127 characters.
  return `${BRAND.product} — ${state} · Vision: ${vision}`.slice(0, 127);
}

export type TrayIconVariant = 'tray' | 'tray-paused' | 'tray-vision';

export function trayIconVariant(ctx: MenuContext): TrayIconVariant {
  if (ctx.paused) return 'tray-paused';
  if (ctx.perceptionMode !== 'off' && !ctx.perceptionPaused) return 'tray-vision';
  return 'tray';
}
