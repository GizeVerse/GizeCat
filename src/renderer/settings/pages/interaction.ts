import type { PageContext, PageView } from '../context';
import { bullets, button, group, page, setNote, sliderRow, toggleRow } from '../controls';
import { h, icon } from '../dom';
import { NUMERIC_FIELDS } from '../fields';
import { S } from '../strings';

const I = S.interaction;

export function interactionPage(ctx: PageContext): PageView {
  const enabled = toggleRow(ctx, 'interaction', 'enabled', { title: I.enabledTitle, desc: I.enabledDesc, icon: 'touch' });
  const petting = toggleRow(ctx, 'interaction', 'petting', { title: I.pettingTitle, desc: I.pettingDesc, icon: 'heart' });
  const dragging = toggleRow(ctx, 'interaction', 'dragging', { title: I.draggingTitle, desc: I.draggingDesc, icon: 'mouse' });
  const throwing = toggleRow(ctx, 'interaction', 'throwing', { title: I.throwingTitle, desc: I.throwingDesc, icon: 'sparkle' });
  const patience = sliderRow(ctx, NUMERIC_FIELDS.patience, { title: I.patienceTitle, desc: I.patienceDesc, icon: 'history' });

  // Laser mode is started and stopped on the Companion page (it is a live action, not a setting); this
  // page only explains it, next to the other ways of meeting the cat.
  const laserGo = button(I.laserGo, { icon: 'mouse' });
  laserGo.addEventListener('click', () => ctx.navigate('companion'));
  const laser = h('div', { class: 'row row-block' }, [h('p', { class: 'row-desc', text: I.laserIntro }), bullets(I.laserPoints), h('div', { class: 'actions' }, [laserGo])]);

  const element = page(I.title, [
    group(null, [enabled.parts.row]),
    group(I.groupPointer, [petting.parts.row, dragging.parts.row, throwing.parts.row, patience.parts.row]),
    group(I.groupLaser, [laser]),
    h('p', { class: 'page-note' }, [icon('info'), h('span', { text: S.access.clickThroughNote })]),
  ]);

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
