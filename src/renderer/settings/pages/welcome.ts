import type { PageContext, PageView } from '../context';
import { button, page, runAction, setNote, statusLine } from '../controls';
import { h, icon, type GlyphName } from '../dom';
import { formatShortcut } from '../format';
import { coatArt } from '../skins';
import { deviceWords, platformWording, S, type PlatformWording } from '../strings';

const W = S.welcome;
const CONTROL_ICONS: readonly GlyphName[] = ['touch', 'mouse', 'heart', 'more', 'pin'];
/** Index in W.privacyPoints of the point about what the app knows. */
const KNOWS_POINT = 1;

/**
 * The platform-specific parts of Welcome (1.4.0). Windows keeps its text; elsewhere the cat keeps to
 * the floor, and the tray entry and the privacy points use that platform's words. The point about
 * what the app knows is replaced there: it does not track windows or infer typing. Order and length
 * stay, because the page shows the first point separately.
 */
export function welcomePlatformText(wording: PlatformWording): {
  intro: (name: string) => string;
  controls: ReadonlyArray<{ title: string; text: string }>;
  privacyPoints: readonly string[];
} {
  if (wording === 'windows') return { intro: W.intro, controls: W.controls, privacyPoints: W.privacyPoints };
  return {
    intro: W.introFloorOnly,
    controls: [...W.controls.slice(0, -1), wording === 'mac' ? W.controlTrayMac : W.controlTrayElsewhere],
    privacyPoints: W.privacyPoints.map((p, i) => deviceWords(i === KNOWS_POINT ? W.privacyPointFloorOnly : p, wording)),
  };
}

export function welcomePage(ctx: PageContext): PageView {
  const wording = platformWording(ctx.store.view.status.platform);
  const text = welcomePlatformText(wording);
  const heading = h('h2', { class: 'hero-title' });
  const intro = h('p', { class: 'hero-text' });
  const art = h('div', { class: 'hero-art', 'aria-hidden': 'true' });

  const controls = h(
    'ul',
    { class: 'tips' },
    text.controls.map((c, i) =>
      h('li', { class: 'tip' }, [icon(CONTROL_ICONS[i] ?? 'info', 'tip-icon'), h('div', {}, [h('div', { class: 'tip-title', text: c.title }), h('div', { class: 'tip-text', text: c.text })])]),
    ),
  );
  const shortcutText = h('div', { class: 'tip-text' });
  controls.append(h('li', { class: 'tip' }, [icon('keyboard', 'tip-icon'), h('div', {}, [h('div', { class: 'tip-title', text: W.shortcutTitle }), shortcutText])]));

  const modePoint = h('li');
  const privacy = h('div', { class: 'callout callout-privacy' }, [
    icon('shield', 'callout-icon'),
    h('div', {}, [
      h('h2', { class: 'callout-title', text: W.privacyTitle }),
      h('ul', { class: 'bullets' }, [modePoint, ...text.privacyPoints.slice(1).map((p) => h('li', { text: p }))]),
    ]),
  ]);

  const start = button(W.start, { variant: 'accent' });
  const openPrivacy = button(W.openPrivacy, { icon: 'shield' });
  const status = statusLine();
  start.addEventListener('click', () => {
    void runAction(ctx, 'completeFirstRun', start, status).then((ok) => {
      if (ok) {
        setNote(status, W.started, 'ok');
        ctx.navigate('general');
      }
    });
  });
  openPrivacy.addEventListener('click', () => ctx.navigate('privacy'));

  const element = page(S.nav.welcome, [
    h('div', { class: 'hero' }, [art, h('div', { class: 'hero-copy' }, [heading, intro])]),
    h('section', { class: 'group' }, [h('h2', { class: 'group-title', text: W.controlsTitle }), controls]),
    privacy,
    h('div', { class: 'actions' }, [start, openPrivacy]),
    status,
  ]);

  let artSkin = '';
  ctx.store.subscribe((view) => {
    const s = view.settings;
    heading.textContent = s.general.firstRunCompleted ? W.titleBack : W.title;
    intro.textContent = text.intro(s.general.catName);
    shortcutText.textContent = s.general.shortcutsEnabled ? W.shortcutText(formatShortcut(s.general.toggleShortcut, wording)) : W.shortcutDisabled;
    start.hidden = s.general.firstRunCompleted;
    const mode = view.status.perception.mode;
    modePoint.textContent = mode === 'off' ? (text.privacyPoints[0] ?? '') : deviceWords(`${S.privacy.banner[mode].title}. ${S.privacy.banner[mode].text}`, wording);
    if (artSkin !== s.appearance.skin) {
      artSkin = s.appearance.skin;
      art.replaceChildren(coatArt(s.appearance.skin));
    }
  });

  return { id: 'welcome', title: S.nav.welcome, element };
}
