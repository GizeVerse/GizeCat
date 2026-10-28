import type { PageContext, PageView } from '../context';
import { button, page, runAction, setNote, statusLine } from '../controls';
import { h, icon, type GlyphName } from '../dom';
import { formatShortcut } from '../format';
import { coatArt } from '../skins';
import { S } from '../strings';

const W = S.welcome;
const CONTROL_ICONS: readonly GlyphName[] = ['touch', 'mouse', 'heart', 'more', 'pin'];

export function welcomePage(ctx: PageContext): PageView {
  const heading = h('h2', { class: 'hero-title' });
  const intro = h('p', { class: 'hero-text' });
  const art = h('div', { class: 'hero-art', 'aria-hidden': 'true' });

  const controls = h(
    'ul',
    { class: 'tips' },
    W.controls.map((c, i) =>
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
      h('ul', { class: 'bullets' }, [modePoint, ...W.privacyPoints.slice(1).map((p) => h('li', { text: p }))]),
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
    intro.textContent = W.intro(s.general.catName);
    shortcutText.textContent = s.general.shortcutsEnabled ? W.shortcutText(formatShortcut(s.general.toggleShortcut)) : W.shortcutDisabled;
    start.hidden = s.general.firstRunCompleted;
    const mode = view.status.perception.mode;
    modePoint.textContent = mode === 'off' ? (W.privacyPoints[0] ?? '') : `${S.privacy.banner[mode].title}. ${S.privacy.banner[mode].text}`;
    if (artSkin !== s.appearance.skin) {
      artSkin = s.appearance.skin;
      art.replaceChildren(coatArt(s.appearance.skin));
    }
  });

  return { id: 'welcome', title: S.nav.welcome, element };
}
