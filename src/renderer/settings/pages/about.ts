import type { PageContext, PageView } from '../context';
import { bullets, group, page } from '../controls';
import { h } from '../dom';
import { brandMark } from '../skins';
import { S } from '../strings';

const A = S.about;

export function aboutPage(ctx: PageContext): PageView {
  const version = h('div', { class: 'about-version' });
  const dataFolder = h('div', { class: 'path' });
  const element = page(A.title, [
    h('div', { class: 'row row-block about-head' }, [
      h('div', { class: 'about-art', 'aria-hidden': 'true' }, [brandMark()]),
      h('div', {}, [
        // Reads "GizeCat — a GizeVerse character (formerly Desktop Cat)" as one heading.
        h('h2', { class: 'about-name' }, [h('span', { text: S.app.brand }), h('span', { class: 'about-identity', text: A.identity })]),
        h('div', { class: 'row-desc', text: A.tagline }),
        version,
        h('div', { class: 'row-desc', text: `${A.license} ${A.copyright}` }),
      ]),
    ]),
    group(A.groupPrivacy, [h('div', { class: 'row row-block' }, [bullets(A.promise)])]),
    group(A.groupThirdParty, [h('div', { class: 'row row-block' }, [h('p', { class: 'row-desc', text: A.thirdParty })])]),
    group(A.groupUninstall, [h('div', { class: 'row row-block' }, [h('p', { class: 'row-desc', text: A.uninstall }), dataFolder])]),
  ]);
  ctx.store.subscribe((view) => {
    version.textContent = A.version(view.versions.app || view.status.version);
    dataFolder.textContent = view.paths.userData;
  });
  return { id: 'about', title: A.title, element };
}
