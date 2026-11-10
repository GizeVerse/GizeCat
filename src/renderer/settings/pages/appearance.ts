import { RENDER_STYLES, SKINS, type SkinId } from '../../../shared/cat';
import { MAX_CAT_NAME_LENGTH } from '../catalog';
import type { PageContext, PageView } from '../context';
import { group, page, radioGroup, row, segmentedRow, setNote, sliderRow, textRow, toggleRow, type RadioItem } from '../controls';
import { h, icon } from '../dom';
import { NUMERIC_FIELDS } from '../fields';
import { fieldId } from '../patch';
import { coatArt } from '../skins';
import type { FieldBinding } from '../store';
import { platformWording, S } from '../strings';
import { validateCatName } from '../validate';

const A = S.appearance;
const G = S.general;

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

/**
 * Appearance: the cat's name, its coat and size, and the visual preferences. Sound moved to the Audio
 * page, and the name here used to sit on General: it is the same setting (general.catName).
 */
export function appearancePage(ctx: PageContext): PageView {
  const name = textRow(ctx, 'general', 'catName', {
    title: G.nameTitle,
    desc: G.nameDesc,
    icon: 'rename',
    validate: validateCatName,
    toValue: (v) => v,
    maxLength: MAX_CAT_NAME_LENGTH + 8,
    spellcheck: false,
  });
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
  const capture = toggleRow(ctx, 'appearance', 'hideFromScreenCapture', { title: A.captureTitle, desc: platformWording(ctx.store.view.status.platform) === 'mac' ? A.captureDescMac : A.captureDesc, icon: 'hide' });

  const element = page(A.title, [
    group(A.groupCat, [name.parts.row]),
    group(A.groupLook, [skinPicker(ctx), style.parts.row, size.parts.row, opacity.parts.row, speed.parts.row]),
    group(A.groupEffects, [shadow.parts.row, emotes.parts.row, capture.parts.row]),
  ]);

  return { id: 'appearance', title: A.title, element };
}
