// 1.4.0 profile transfer in main (src/main/profile/profileService.ts): export through the save
// dialog, open through the open dialog with a size cap before reading, a single pending slot behind
// a sender-bound token with a TTL, and an apply that changes nothing before it is confirmed and
// nothing at all when it fails. MOCKED: dialogs, file access, the settings store and the sim.
// Written in the 1.4.0 mission, NOT executed there.
import { describe, expect, it } from 'vitest';
import { mulberry32, newPersistedCat } from '../../../src/core/behavior';
import type { PersistedCat } from '../../../src/shared/catState';
import { buildProfile, MAX_PROFILE_BYTES, parseProfile, serializeProfile } from '../../../src/shared/profileTransfer';
import { applySettingsPatch, defaultSettings, type Settings, type SettingsPatch } from '../../../src/shared/settings';
import { createProfileTransferService, PROFILE_TOKEN_TTL_MS, rejectImportPatch, withProfileExtension, type CappedRead, type ProfileTransferDeps } from '../../../src/main/profile/profileService';
import { memoryLogger } from './helpers';

const WALL = 1_800_000_000_000;
const TOKEN = 'a'.repeat(32);
const PATH = 'C:\\Users\\someone\\Documents\\SECRET-FOLDER\\gizecat-miso.json';

function rig(opts: { fileText?: string; fileSize?: number; isFile?: boolean; savePath?: string | null; openPath?: string | null; adoptThrows?: boolean; patchFails?: boolean; existing?: string[]; createError?: string } = {}) {
  let settings: Settings = defaultSettings();
  settings.general.catName = 'Pamuk';
  let cat: PersistedCat = newPersistedCat(mulberry32(1), WALL - 86_400_000);
  const written: Array<{ path: string; text: string; createOnly: boolean }> = [];
  const reads: string[] = [];
  const patches: SettingsPatch[] = [];
  const adopted: PersistedCat[] = [];
  let clock = 0;
  let tokens = 0;
  const log = memoryLogger();
  const deps: ProfileTransferDeps = {
    settings: {
      get: () => settings,
      patch: (p) => {
        patches.push(p);
        if (opts.patchFails) return { ok: false, error: 'disk full' };
        const r = applySettingsPatch(settings, p);
        if (r.ok) settings = r.settings;
        return r;
      },
    },
    getCat: () => cat,
    adoptCat: (c) => {
      if (opts.adoptThrows) throw new Error('nope');
      adopted.push(c);
      cat = c;
    },
    dialogs: {
      chooseSavePath: () => Promise.resolve(opts.savePath === undefined ? PATH : opts.savePath),
      chooseOpenPath: () => Promise.resolve(opts.openPath === undefined ? PATH : opts.openPath),
    },
    fs: {
      writeText: (p, text, o) => {
        const createOnly = o?.createOnly === true;
        // node:fs flag 'wx': an existing file is never replaced.
        if (createOnly && opts.createError !== undefined) return Promise.reject(Object.assign(new Error(`${opts.createError}: open '${p}'`), { code: opts.createError }));
        if (createOnly && (opts.existing ?? []).includes(p)) return Promise.reject(Object.assign(new Error(`EEXIST: file already exists, open '${p}'`), { code: 'EEXIST' }));
        written.push({ path: p, text, createOnly });
        return Promise.resolve();
      },
      stat: () => Promise.resolve({ isFile: opts.isFile ?? true, size: opts.fileSize ?? (opts.fileText ?? '').length }),
      readTextCapped: (p, max): Promise<CappedRead> => {
        reads.push(p);
        const text = opts.fileText ?? '';
        return Promise.resolve(text.length > max ? { ok: false, reason: 'too-large' } : { ok: true, text });
      },
    },
    app: { version: '1.4.0', host: 'win32' },
    newToken: () => (tokens++ === 0 ? TOKEN : 'b'.repeat(32)),
    wallClock: () => WALL,
    clock: () => clock,
    basename: (p) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1),
    logger: log,
  };
  const service = createProfileTransferService(deps);
  return {
    service,
    log,
    written,
    reads,
    patches,
    adopted,
    advance: (ms: number) => (clock += ms),
    get settings() {
      return settings;
    },
    get cat() {
      return cat;
    },
  };
}

/** A profile file of another cat, named Miso, with a grey coat. */
function otherCatFile(): string {
  const s = defaultSettings();
  s.general.catName = 'Miso';
  s.appearance.skin = 'gray';
  const theirs = newPersistedCat(mulberry32(42), WALL - 10 * 86_400_000);
  return serializeProfile(buildProfile(s, theirs, { includeMemory: true, app: { version: '1.4.0', host: 'darwin' }, now: WALL }));
}

const ALL = { cat: true, appearance: true, preferences: true, memory: false };

function noPathOrName(log: ReturnType<typeof memoryLogger>): void {
  const text = JSON.stringify(log.entries);
  expect(text).not.toContain('SECRET-FOLDER');
  expect(text).not.toContain('Users');
  expect(text).not.toContain('Miso');
  expect(text).not.toContain('Pamuk');
  expect(text).not.toContain(TOKEN);
}

describe('profile export', () => {
  it('writes a file this build can read back, names it, and logs no path or name', async () => {
    const r = rig();
    const res = await r.service.exportToFile({ includeMemory: false });
    expect(res).toEqual({ status: 'saved', fileName: 'gizecat-miso.json' });
    expect(r.written).toHaveLength(1);
    const back = parseProfile(r.written[0]!.text);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.profile.cat.name).toBe('Pamuk');
      expect(back.profile.memory).toBeNull();
    }
    noPathOrName(r.log);
  });

  it('includes what the cat has learned only when asked', async () => {
    const r = rig();
    await r.service.exportToFile({ includeMemory: true });
    const back = parseProfile(r.written[0]!.text);
    expect(back.ok && back.profile.memory !== null).toBe(true);
  });

  it('never carries API-key, perception or AI material (only allow-listed fields)', async () => {
    const r = rig();
    await r.service.exportToFile({ includeMemory: true });
    const text = r.written[0]!.text;
    for (const word of ['perception', 'apiKey', 'consentAt', 'provider', 'loginItem', 'diagnostics', 'lastPosition', 'favoriteSpots', 'Documents']) expect(text).not.toContain(word);
  });

  it('a cancelled dialog writes nothing; a failed write is reported by code, never with the path', async () => {
    const cancelled = rig({ savePath: null });
    expect(await cancelled.service.exportToFile({ includeMemory: false })).toEqual({ status: 'cancelled' });
    expect(cancelled.written).toHaveLength(0);

    // A writer that fails with an fs-style error, whose message holds the path.
    const err = Object.assign(new Error(`EACCES: permission denied, open '${PATH}'`), { code: 'EACCES' });
    const log = memoryLogger();
    const svc = createProfileTransferService({
      settings: { get: defaultSettings, patch: (p) => applySettingsPatch(defaultSettings(), p) },
      getCat: () => newPersistedCat(mulberry32(1), WALL),
      adoptCat: () => undefined,
      dialogs: { chooseSavePath: () => Promise.resolve(PATH), chooseOpenPath: () => Promise.resolve(null) },
      fs: { writeText: () => Promise.reject(err), stat: () => Promise.reject(err), readTextCapped: () => Promise.reject(err) },
      app: { version: '1.4.0', host: 'win32' },
      newToken: () => TOKEN,
      wallClock: () => WALL,
      clock: () => 0,
      basename: (p) => p,
      logger: log,
    });
    expect(await svc.exportToFile({ includeMemory: false })).toEqual({ status: 'failed' });
    expect(JSON.stringify(log.entries)).toContain('EACCES');
    expect(JSON.stringify(log.entries)).not.toContain('SECRET-FOLDER');
  });

  it('the path the dialog returned is written as is (its overwrite prompt covered it)', async () => {
    const r = rig();
    await r.service.exportToFile({ includeMemory: false });
    expect(r.written.map((w) => [w.path, w.createOnly])).toEqual([[PATH, false]]);
  });

  it('a name without extension gets .json, but only as a new file (SEC-3)', async () => {
    const r = rig({ savePath: '/home/u/mycat' });
    expect(await r.service.exportToFile({ includeMemory: false })).toEqual({ status: 'saved', fileName: 'mycat.json' });
    expect(r.written.map((w) => [w.path, w.createOnly])).toEqual([['/home/u/mycat.json', true]]);
  });

  it('never replaces an existing <name>.json the user did not confirm: the exact chosen path is written (SEC-3)', async () => {
    const r = rig({ savePath: '/home/u/mycat', existing: ['/home/u/mycat.json'] });
    expect(await r.service.exportToFile({ includeMemory: false })).toEqual({ status: 'saved', fileName: 'mycat' });
    expect(r.written.map((w) => w.path)).toEqual(['/home/u/mycat']);
    expect(r.written.some((w) => w.path === '/home/u/mycat.json')).toBe(false);
    expect(parseProfile(r.written[0]!.text).ok).toBe(true);
    expect(JSON.stringify(r.log.entries)).not.toContain('/home/u');
  });

  it('any other failure creating <name>.json writes nothing else and reports failed', async () => {
    const r = rig({ savePath: '/home/u/mycat', createError: 'EACCES' });
    expect(await r.service.exportToFile({ includeMemory: false })).toEqual({ status: 'failed' });
    expect(r.written).toHaveLength(0);
    expect(JSON.stringify(r.log.entries)).not.toContain('/home/u');
  });

  it('adds the .json extension when the chosen name has none (Linux dialogs do not)', () => {
    const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
    expect(withProfileExtension('/home/u/miso', base)).toBe('/home/u/miso.json');
    expect(withProfileExtension('/home/u/miso.json', base)).toBe('/home/u/miso.json');
    expect(withProfileExtension('/home/u.d/miso', base)).toBe('/home/u.d/miso.json');
  });
});

describe('profile open (preview only)', () => {
  it('previews a file and changes nothing yet', async () => {
    const r = rig({ fileText: otherCatFile() });
    const res = await r.service.openForImport(3);
    expect(res.status).toBe('ready');
    if (res.status !== 'ready') return;
    expect(res.token).toBe(TOKEN);
    expect(res.preview.incoming.name).toBe('Miso');
    expect(res.preview.sameCat).toBe(false);
    expect(r.patches).toHaveLength(0);
    expect(r.adopted).toHaveLength(0);
    expect(r.service.hasPending).toBe(true);
    noPathOrName(r.log);
  });

  it('refuses an oversized file before reading it, and a non-file', async () => {
    const big = rig({ fileText: 'x', fileSize: MAX_PROFILE_BYTES + 1 });
    expect(await big.service.openForImport(3)).toEqual({ status: 'rejected', reason: 'too-large' });
    expect(big.reads).toHaveLength(0);
    const dir = rig({ isFile: false });
    expect(await dir.service.openForImport(3)).toEqual({ status: 'rejected', reason: 'unreadable' });
    expect(dir.reads).toHaveLength(0);
  });

  it('a file that grew past the cap after stat is refused by the capped read', async () => {
    const r = rig({ fileText: 'y'.repeat(MAX_PROFILE_BYTES + 5), fileSize: 10 });
    expect(await r.service.openForImport(3)).toEqual({ status: 'rejected', reason: 'too-large' });
  });

  it('words the format reasons as codes: not a profile, newer major (with the major), damaged', async () => {
    expect(await rig({ fileText: '{"hello":1}' }).service.openForImport(3)).toEqual({ status: 'rejected', reason: 'not-a-profile' });
    const newer = JSON.parse(otherCatFile()) as { format: { major: number } };
    newer.format.major = 2;
    expect(await rig({ fileText: JSON.stringify(newer) }).service.openForImport(3)).toEqual({ status: 'rejected', reason: 'newer-format', formatMajor: 2 });
    expect(await rig({ fileText: 'not json' }).service.openForImport(3)).toEqual({ status: 'rejected', reason: 'not-json' });
  });

  it('cancel returns cancelled; one dialog at a time (busy)', async () => {
    expect(await rig({ openPath: null }).service.openForImport(3)).toEqual({ status: 'cancelled' });
    let release: (p: string | null) => void = () => undefined;
    const r = rig();
    const svc = createProfileTransferService({
      settings: { get: defaultSettings, patch: (p) => applySettingsPatch(defaultSettings(), p) },
      getCat: () => r.cat,
      adoptCat: () => undefined,
      dialogs: { chooseSavePath: () => Promise.resolve(null), chooseOpenPath: () => new Promise((res) => (release = res)) },
      fs: { writeText: () => Promise.resolve(), stat: () => Promise.resolve({ isFile: true, size: 1 }), readTextCapped: () => Promise.resolve({ ok: true, text: '{}' }) },
      app: { version: '1.4.0', host: 'win32' },
      newToken: () => TOKEN,
      wallClock: () => WALL,
      clock: () => 0,
      basename: (p) => p,
      logger: memoryLogger(),
    });
    const first = svc.openForImport(3);
    expect(await svc.openForImport(3)).toEqual({ status: 'busy' });
    expect(await svc.exportToFile({ includeMemory: false })).toEqual({ status: 'busy' });
    release(null);
    expect(await first).toEqual({ status: 'cancelled' });
  });
});

describe('profile apply', () => {
  it('applies only after open, with the right token and sender: settings first, then the cat', async () => {
    const r = rig({ fileText: otherCatFile() });
    const open = await r.service.openForImport(3);
    expect(open.status).toBe('ready');
    expect(r.service.applyImport(4, { token: TOKEN, parts: ALL })).toEqual({ ok: false, reason: 'expired' });
    expect(r.service.applyImport(3, { token: 'c'.repeat(32), parts: ALL })).toEqual({ ok: false, reason: 'expired' });
    expect(r.patches).toHaveLength(0);
    const res = r.service.applyImport(3, { token: TOKEN, parts: ALL });
    expect(res).toEqual({ ok: true, name: 'Miso', catReplaced: true, keptOff: [] });
    expect(r.settings.general.catName).toBe('Miso');
    expect(r.settings.appearance.skin).toBe('gray');
    expect(r.adopted).toHaveLength(1);
    // The slot is single-use.
    expect(r.service.applyImport(3, { token: TOKEN, parts: ALL })).toEqual({ ok: false, reason: 'expired' });
    noPathOrName(r.log);
  });

  it('a token older than the TTL is expired', async () => {
    const r = rig({ fileText: otherCatFile() });
    await r.service.openForImport(3);
    r.advance(PROFILE_TOKEN_TTL_MS + 1);
    expect(r.service.applyImport(3, { token: TOKEN, parts: ALL })).toEqual({ ok: false, reason: 'expired' });
    expect(r.patches).toHaveLength(0);
  });

  it('nothing selected keeps the preview open for another try', async () => {
    const r = rig({ fileText: otherCatFile() });
    await r.service.openForImport(3);
    expect(r.service.applyImport(3, { token: TOKEN, parts: { cat: false, appearance: false, preferences: false, memory: false } })).toEqual({ ok: false, reason: 'nothing-selected' });
    expect(r.service.hasPending).toBe(true);
  });

  it('a failed settings save changes nothing, and a failed adoption puts the settings back', async () => {
    const saveFails = rig({ fileText: otherCatFile(), patchFails: true });
    await saveFails.service.openForImport(3);
    expect(saveFails.service.applyImport(3, { token: TOKEN, parts: ALL })).toEqual({ ok: false, reason: 'failed' });
    expect(saveFails.adopted).toHaveLength(0);

    const adoptFails = rig({ fileText: otherCatFile(), adoptThrows: true });
    await adoptFails.service.openForImport(3);
    expect(adoptFails.service.applyImport(3, { token: TOKEN, parts: ALL })).toEqual({ ok: false, reason: 'failed' });
    expect(adoptFails.settings.general.catName).toBe('Pamuk');
    expect(adoptFails.settings.appearance.skin).toBe(defaultSettings().appearance.skin);
  });

  it('never enables screen analysis or AI, and leaves device-only settings alone', async () => {
    const r = rig({ fileText: otherCatFile() });
    await r.service.openForImport(3);
    r.service.applyImport(3, { token: TOKEN, parts: { cat: true, appearance: true, preferences: true, memory: true } });
    for (const p of r.patches) {
      expect(Object.keys(p).every((k) => ['general', 'appearance', 'behavior', 'interaction', 'sound'].includes(k))).toBe(true);
      expect(Object.keys(p.general ?? {})).not.toContain('shortcutsEnabled');
    }
    expect(r.settings.perception.visualMode).toBe('off');
    expect(r.settings.ai.provider).toBe(defaultSettings().ai.provider);
  });
});

describe('rejectImportPatch (defense in depth)', () => {
  it('refuses consent, main-owned sections, unknown sections, other general keys and activityPreset', () => {
    expect(rejectImportPatch({ appearance: { skin: 'gray' } })).toBeNull();
    expect(rejectImportPatch({ perception: { visualMode: 'local-stats' } })).not.toBeNull();
    expect(rejectImportPatch({ perception: { consentAt: '2026-01-01T00:00:00.000Z' } })).not.toBeNull();
    expect(rejectImportPatch({ ai: { allowCloud: true } })).not.toBeNull();
    expect(rejectImportPatch({ general: { toggleShortcut: 'Control+X' } })).not.toBeNull();
    expect(rejectImportPatch({ behavior: { activityPreset: 'calm' } })).not.toBeNull();
    expect(rejectImportPatch({ diagnostics: { logLevel: 'debug' } })).not.toBeNull();
  });
});
