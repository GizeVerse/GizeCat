import type { ToggleableBehavior } from '../../../shared/settings';
import { BEHAVIOR_IDS } from '../catalog';
import type { PageContext, PageView } from '../context';
import { group, page, row, segmentedRow, setNote, sliderRow, toggleRow, toggleSwitch } from '../controls';
import { NUMERIC_FIELDS } from '../fields';
import { fieldId, setBehaviorEnabled } from '../patch';
import type { FieldBinding } from '../store';
import { S } from '../strings';

const B = S.behavior;

function behaviorToggle(ctx: PageContext, behavior: ToggleableBehavior): HTMLElement {
  const text = B.behaviors[behavior];
  const parts = row({ title: text.title, desc: text.desc });
  const sw = toggleSwitch(parts.titleId, parts.describedBy);
  parts.control.append(sw.root);
  const binding: FieldBinding = {
    field: fieldId('behavior', 'disabledBehaviors'),
    isBusy: () => false,
    sync: (v) => {
      sw.input.checked = !(Array.isArray(v) && (v as unknown[]).includes(behavior));
      sw.refresh();
    },
    showError: (msg) => setNote(parts.error, msg, 'error'),
  };
  sw.input.addEventListener('change', () => {
    const next = setBehaviorEnabled(ctx.store.intended('behavior', 'disabledBehaviors'), behavior, sw.input.checked);
    ctx.store.set('behavior', 'disabledBehaviors', next, { origin: binding });
  });
  ctx.store.bind(binding);
  return parts.row;
}

export function behaviorPage(ctx: PageContext): PageView {
  const F = NUMERIC_FIELDS;
  const activity = [
    sliderRow(ctx, F.movementSpeed, { title: B.speedTitle, desc: B.speedDesc, icon: 'behavior' }),
    sliderRow(ctx, F.autonomy, { title: B.autonomyTitle, desc: B.autonomyDesc, icon: 'lightbulb' }),
    sliderRow(ctx, F.cursorPlay, { title: B.cursorPlayTitle, desc: B.cursorPlayDesc, icon: 'mouse' }),
    sliderRow(ctx, F.attentionSeeking, { title: B.attentionTitle, desc: B.attentionDesc, icon: 'message' }),
    sliderRow(ctx, F.activitySensitivity, { title: B.sensitivityTitle, desc: B.sensitivityDesc, icon: 'sparkle' }),
    sliderRow(ctx, F.sleepAfterIdleMinutes, { title: B.sleepTitle, desc: B.sleepDesc, icon: 'moon' }),
  ];
  const awareness = [
    toggleRow(ctx, 'behavior', 'allowMultiMonitor', { title: B.multiMonitorTitle, desc: B.multiMonitorDesc, icon: 'monitor' }).parts.row,
    toggleRow(ctx, 'behavior', 'reactToTyping', { title: B.typingTitle, desc: B.typingDesc, icon: 'keyboard' }).parts.row,
    toggleRow(ctx, 'behavior', 'reactToWindows', { title: B.windowsTitle, desc: B.windowsDesc, icon: 'window' }).parts.row,
    segmentedRow(
      ctx,
      'behavior',
      'fullscreenBehavior',
      (['hide', 'quiet', 'ignore'] as const).map((v) => ({ value: v, label: B.fullscreen[v] })),
      { title: B.fullscreenTitle, desc: B.fullscreenDesc, icon: 'fullscreen' },
    ).parts.row,
  ];
  const element = page(B.title, [
    group(B.groupActivity, activity.map((s) => s.parts.row)),
    group(B.groupAwareness, awareness),
    group(B.groupBehaviors, BEHAVIOR_IDS.map((b) => behaviorToggle(ctx, b)), B.groupBehaviorsDesc),
  ]);
  return { id: 'behavior', title: B.title, element };
}
