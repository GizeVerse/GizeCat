// Pure descriptions of the tray menu, tray tooltip/icon and the cat's right-click
// menu. tray.ts and the overlay manager turn these into native menus.
import type { BehaviorState } from '../../shared/cat';
import type { PerceptionMode } from '../../shared/perception';

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
    item('settings', 'Settings…'),
    { kind: 'separator' },
    item('quit', 'Quit Desktop Cat'),
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
    { kind: 'separator' },
    item(ctx.paused ? 'resume' : 'pause', ctx.paused ? 'Resume' : 'Pause'),
    item('hide', 'Hide'),
    { kind: 'separator' },
    item('settings', 'Settings…'),
    item('quit', 'Quit Desktop Cat'),
  ];
}

export function trayTooltip(ctx: MenuContext): string {
  const state = ctx.hidden ? 'hidden' : ctx.paused ? 'paused' : describeState(ctx.state);
  let vision = VISION_LABEL[ctx.perceptionMode];
  if (ctx.perceptionMode !== 'off' && ctx.perceptionPaused) vision += ' (paused)';
  // Windows truncates notification-area tooltips at 127 characters.
  return `Desktop Cat — ${state} · Vision: ${vision}`.slice(0, 127);
}

export type TrayIconVariant = 'tray' | 'tray-paused' | 'tray-vision';

export function trayIconVariant(ctx: MenuContext): TrayIconVariant {
  if (ctx.paused) return 'tray-paused';
  if (ctx.perceptionMode !== 'off' && !ctx.perceptionPaused) return 'tray-vision';
  return 'tray';
}
