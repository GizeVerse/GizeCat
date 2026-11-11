// The web host's copies of the desktop settings labels (src/web/strings.ts) stay equal to the
// desktop's (src/renderer/settings/strings.ts): the same cat has the same coat and personality names
// everywhere. Also: the install text per hint, and no wording that promises device behaviour.
import { describe, expect, it } from 'vitest';
import { S } from '../../../src/renderer/settings/strings';
import { installText, WS } from '../../../src/web/strings';

describe('web strings', () => {
  it('copies the coat, drawing style and personality labels from the desktop settings exactly', () => {
    expect(WS.skins).toEqual(S.appearance.skins);
    expect(WS.styles).toEqual(S.appearance.styles);
    expect(WS.presets).toEqual(S.behavior.presets);
  });

  it('the Android clear-journal confirmation names what the clear deletes, like the desktop page', () => {
    expect(WS.panel.journal.clearAsk).toMatch(/event history/);
    expect(WS.panel.journal.clearAsk).toMatch(/event counters/);
    expect(WS.panel.journal.clearAsk).toMatch(/cannot be undone/);
  });

  it('has a line for every offline state, and links the notices from About', () => {
    for (const state of ['unavailable', 'preparing', 'ready', 'update-ready', 'failed'] as const) expect(WS.offline[state]).toMatch(/\S/);
    expect(WS.offline.ready).toContain('Ready to work offline');
    expect(WS.offline['update-ready']).toContain('new version');
    expect(WS.about.licenses).toMatch(/\S/);
    expect(WS.about.privacy).toMatch(/\S/);
  });

  it('has a text for every install hint except none', () => {
    expect(installText('none')).toBeNull();
    for (const hint of ['installed', 'prompt', 'apple', 'menu'] as const) expect(installText(hint)).toMatch(/\S/);
    expect(installText('apple')).toContain('Add to Home Screen');
  });

  it('says "this app" in the app and "this browser" in a tab', () => {
    expect(WS.storage.status('app', null)).toContain('this app');
    expect(WS.storage.status('browser', null)).toContain('this browser');
    expect(WS.privacy.text('app').join(' ')).not.toContain('browser');
    expect(WS.storage.status('browser', 'persisted')).toContain('agreed to keep');
    expect(WS.storage.status('browser', 'best-effort')).toContain('may clear');
  });
});
