import type { AppStatus } from '../../../shared/ipc';
import type { PageContext, PageView } from '../context';
import { bullets, group, page } from '../controls';
import { h } from '../dom';
import { brandMark } from '../skins';
import { platformWording, S } from '../strings';

const A = S.about;

/**
 * The platform-specific parts of About (1.4.0): the API-key promise (who encrypts the keys, as
 * src/main/store/secretStore.ts says it) and how to uninstall. Windows (and no platform report) keeps
 * the pre-1.4.0 text.
 */
export function aboutPlatformText(platform: AppStatus['platform']): { promise: readonly string[]; uninstall: string } {
  const wording = platformWording(platform);
  if (wording === 'windows') return { promise: A.promise, uninstall: A.uninstall };
  const keys = wording === 'mac' ? A.promiseKeysMac : A.promiseKeysElsewhere;
  return { promise: [...A.promise.slice(0, -1), keys], uninstall: wording === 'mac' ? A.uninstallMac : A.uninstallElsewhere };
}

export function aboutPage(ctx: PageContext): PageView {
  const version = h('div', { class: 'about-version' });
  const dataFolder = h('div', { class: 'path' });
  let platformText = aboutPlatformText(ctx.store.view.status.platform);
  const promiseBox = h('div', { class: 'row row-block' }, [bullets(platformText.promise)]);
  const uninstall = h('p', { class: 'row-desc', text: platformText.uninstall });
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
    group(A.groupPrivacy, [promiseBox]),
    group(A.groupThirdParty, [h('div', { class: 'row row-block' }, [h('p', { class: 'row-desc', text: A.thirdParty })])]),
    group(A.groupUninstall, [h('div', { class: 'row row-block' }, [uninstall, dataFolder])]),
  ]);
  ctx.store.subscribe((view) => {
    const next = aboutPlatformText(view.status.platform);
    if (next.uninstall !== platformText.uninstall) {
      // The promise and the uninstall text change together (one platform wording).
      platformText = next;
      promiseBox.replaceChildren(bullets(next.promise));
      uninstall.textContent = next.uninstall;
    }
    version.textContent = A.version(view.versions.app || view.status.version);
    dataFolder.textContent = view.paths.userData;
  });
  return { id: 'about', title: A.title, element };
}
