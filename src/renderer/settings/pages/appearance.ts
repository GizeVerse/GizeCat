import { RENDER_STYLES, SKINS, type SkinId } from '../../../shared/cat';
import type { PageContext, PageView } from '../context';
import { group, page, radioGroup, row, segmentedRow, setNote, sliderRow, toggleRow, type RadioItem } from '../controls';
import { h, icon } from '../dom';
import { NUMERIC_FIELDS } from '../fields';
import { fieldId } from '../patch';
import { coatArt } from '../skins';
import type { FieldBinding } from '../store';
import { S } from '../strings';

const A = S.appearance;

function skinPicker(ctx: PageContext): HTMLElement {
  const parts = row({ title: A.skinTitle, desc: A.skinDesc, icon: 'color', stacked: true });
  const container = h('div', { class: 'swatches', 'aria-labelledby': parts.titleId, 'aria-describedby': parts.describedBy });
  const items: Array<RadioItem<SkinId>> = SKINS.map((skin) => ({
    value: skin,
    el: h('button', { type: 'button', class: 'swatch', 'data-skin': skin }, [
      h('span', { class: 'swatch-art' }, [coatArt(skin), icon('check', 'swatch-check')]),
      h('span', { class: 'swatch-name', text: A.skins[skin] }),
    ]),
  }));
  container.append(...items.map((i) => i.el));
  parts.control.append(container);
  const binding: FieldBinding = {
    field: fieldId('appearance', 'skin'),
    isBusy: () => false,
    sync: (v) => handle.set(v as SkinId),
    showError: (msg) => setNote(parts.error, msg, 'error'),
  };
  const handle = radioGroup<SkinId>(container, items, (skin) => {
    handle.set(skin);
    ctx.store.set('appearance', 'skin', skin, { origin: binding });
  });
  ctx.store.bind(binding);
  return parts.row;
}

export function appearancePage(ctx: PageContext): PageView {
  const style = segmentedRow(
    ctx,
    'appearance',
    'style',
    RENDER_STYLES.map((s) => ({ value: s, label: A.styles[s] })),
    { title: A.styleTitle, desc: A.styleDesc, icon: 'sparkle' },
  );
  const size = sliderRow(ctx, NUMERIC_FIELDS.size, { title: A.sizeTitle, desc: A.sizeDesc, icon: 'zoom' });
  const opacity = sliderRow(ctx, NUMERIC_FIELDS.opacity, { title: A.opacityTitle, desc: A.opacityDesc, icon: 'brightness' });
  const speed = sliderRow(ctx, NUMERIC_FIELDS.animationSpeed, { title: A.animTitle, desc: A.animDesc, icon: 'stopwatch' });
  const shadow = toggleRow(ctx, 'appearance', 'shadow', { title: A.shadowTitle, desc: A.shadowDesc, icon: 'layers' });
  const emotes = toggleRow(ctx, 'appearance', 'emotes', { title: A.emotesTitle, desc: A.emotesDesc, icon: 'heart' });
  const capture = toggleRow(ctx, 'appearance', 'hideFromScreenCapture', { title: A.captureTitle, desc: A.captureDesc, icon: 'hide' });

  const element = page(A.title, [
    group(A.groupLook, [skinPicker(ctx), style.parts.row, size.parts.row, opacity.parts.row, speed.parts.row]),
    group(A.groupEffects, [shadow.parts.row, emotes.parts.row, capture.parts.row]),
  ]);
  return { id: 'appearance', title: A.title, element };
}
