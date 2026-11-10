// Audio: the sound master switch (off by default), the volume and the two kinds of sound. The category
// switches only matter while the master switch is on, so they are disabled (and say why) while it is off.
import type { AppStatus } from '../../../shared/ipc';
import type { PageContext, PageView } from '../context';
import { group, page, setNote, sliderRow, toggleRow } from '../controls';
import { h, icon } from '../dom';
import { NUMERIC_FIELDS, type FieldId } from '../fields';
import { fieldId } from '../patch';
import { deviceWords, platformWording, S } from '../strings';

const A = S.appearance;
const U = S.audio;

/** v1.2 (ADR 0003 §10) and Living Companion: the settings the Audio page has controls for. */
export const SOUND_FIELD_IDS: readonly FieldId[] = [fieldId('sound', 'enabled'), fieldId('sound', 'volume'), fieldId('sound', 'cat'), fieldId('sound', 'world')];

/**
 * The master switch's and the volume's descriptions (1.4.0): Windows (and no platform report) keeps the
 * pre-1.4.0 text naming the Windows volume; macOS names the macOS volume; elsewhere the system volume.
 */
export function soundDescriptions(platform: AppStatus['platform']): { sound: string; volume: string } {
  const wording = platformWording(platform);
  if (wording === 'mac') return { sound: A.soundDescMac, volume: A.volumeDescMac };
  if (wording === 'elsewhere') return { sound: A.soundDescElsewhere, volume: A.volumeDescElsewhere };
  return { sound: A.soundDesc, volume: A.volumeDesc };
}

export function audioPage(ctx: PageContext): PageView {
  const wording = platformWording(ctx.store.view.status.platform);
  let soundText = soundDescriptions(ctx.store.view.status.platform);
  const master = toggleRow(ctx, 'sound', 'enabled', { title: U.masterTitle, desc: soundText.sound, icon: 'volume' });
  const volume = sliderRow(ctx, NUMERIC_FIELDS.soundVolume, { title: A.volumeTitle, desc: soundText.volume, icon: 'volume' });
  const cat = toggleRow(ctx, 'sound', 'cat', { title: U.catTitle, desc: U.catDesc, icon: 'heart' });
  const world = toggleRow(ctx, 'sound', 'world', { title: U.worldTitle, desc: U.worldDesc, icon: 'sparkle' });
  const masterDescEl = master.parts.row.querySelector<HTMLElement>('.row-desc');
  const volumeDescEl = volume.parts.row.querySelector<HTMLElement>('.row-desc');

  const element = page(S.nav.audio, [
    h('p', { class: 'page-note' }, [icon('info'), h('span', { text: deviceWords(U.intro, wording) })]),
    group(U.groupMaster, [master.parts.row, volume.parts.row]),
    group(U.groupKinds, [cat.parts.row, world.parts.row]),
  ]);

  ctx.store.subscribe((view) => {
    const next = soundDescriptions(view.status.platform);
    if (next.sound !== soundText.sound || next.volume !== soundText.volume) {
      soundText = next;
      if (masterDescEl) masterDescEl.textContent = next.sound;
      if (volumeDescEl) volumeDescEl.textContent = next.volume;
    }
    const on = ctx.store.intended('sound', 'enabled');
    volume.setDisabled(!on);
    cat.setDisabled(!on);
    world.setDisabled(!on);
    setNote(volume.parts.note, on ? null : A.volumeNeedsSound, 'info');
    setNote(cat.parts.note, on ? null : U.needsSound, 'info');
    setNote(world.parts.note, on ? null : U.needsSound, 'info');
  });
  return { id: 'audio', title: S.nav.audio, element };
}
