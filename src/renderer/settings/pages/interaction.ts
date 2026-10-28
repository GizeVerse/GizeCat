import type { PageContext, PageView } from '../context';
import { group, page, setNote, sliderRow, toggleRow } from '../controls';
import { NUMERIC_FIELDS } from '../fields';
import { S } from '../strings';

const I = S.interaction;

export function interactionPage(ctx: PageContext): PageView {
  const enabled = toggleRow(ctx, 'interaction', 'enabled', { title: I.enabledTitle, desc: I.enabledDesc, icon: 'touch' });
  const petting = toggleRow(ctx, 'interaction', 'petting', { title: I.pettingTitle, desc: I.pettingDesc, icon: 'heart' });
  const dragging = toggleRow(ctx, 'interaction', 'dragging', { title: I.draggingTitle, desc: I.draggingDesc, icon: 'mouse' });
  const throwing = toggleRow(ctx, 'interaction', 'throwing', { title: I.throwingTitle, desc: I.throwingDesc, icon: 'sparkle' });
  const patience = sliderRow(ctx, NUMERIC_FIELDS.patience, { title: I.patienceTitle, desc: I.patienceDesc, icon: 'history' });

  const element = page(I.title, [group(null, [enabled.parts.row]), group(null, [petting.parts.row, dragging.parts.row, throwing.parts.row, patience.parts.row])]);

  ctx.store.subscribe(() => {
    const on = ctx.store.intended('interaction', 'enabled');
    const drag = ctx.store.intended('interaction', 'dragging');
    petting.setDisabled(!on);
    dragging.setDisabled(!on);
    patience.setDisabled(!on);
    throwing.setDisabled(!on || !drag);
    setNote(enabled.parts.note, on ? null : I.disabledNote, 'info');
    setNote(throwing.parts.note, on && !drag ? I.throwingNeedsDrag : null, 'info');
  });

  return { id: 'interaction', title: I.title, element };
}
