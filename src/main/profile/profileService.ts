// 1.4.0 profile transfer on the desktop ("Take your cat to another device"): main builds, parses,
// previews and applies the profile (src/shared/profileTransfer.ts); the settings renderer only asks
// and shows. Electron-free (dialogs and file access are injected, see profileDialogs.ts), so it runs
// under unit tests.
//
// Security (docs/THREAT_MODEL.md, profile files):
// - A file is only ever read from a path main's own open dialog returned; the renderer never sends
//   file content or a path. The parsed profile waits in one pending slot behind a 128-bit token,
//   bound to the asking webContents, for PROFILE_TOKEN_TTL_MS; apply needs that token.
// - The file's size is checked before it is read, and the read itself stops past the cap.
// - Export only replaces a file the save dialog confirmed: when main adds the .json extension, that
//   path is only created, never overwritten; if it exists, the exact path the user chose is written.
// - Nothing changes before the user confirmed the preview: apply computes everything in memory
//   first (applyProfile), re-checks the settings patch with the renderer-patch guards, commits the
//   settings, then adopts the cat; a failed adopt puts the settings back.
// - Logs carry codes and counts only: never the cat's name, a path or file content.
import type { PersistedCat } from '../../shared/catState';
import { PROFILE_TOKEN_PATTERN, type ProfileApplyResponse, type ProfileExportResponse, type ProfileOpenResponse } from '../../shared/ipc';
import type { PlatformId } from '../../shared/platform';
import {
  applyProfile,
  MAX_PROFILE_BYTES,
  parseProfile,
  prepareProfileExport,
  PROFILE_FILE_EXTENSION,
  PROFILE_PARTS,
  previewImport,
  type GizeProfile,
  type ProfileParts,
} from '../../shared/profileTransfer';
import { rejectConsentBypass, rejectMainOwnedPatch, type Settings, type SettingsPatch } from '../../shared/settings';
import type { Logger } from '../contracts';
import { rejectMainOwnedFields } from '../ipc/startupState';
import type { SettingsStore } from '../store/settingsStore';

/** How long a previewed file can be applied (ms, monotonic clock). */
export const PROFILE_TOKEN_TTL_MS = 10 * 60_000;

/** The only settings sections (and general keys) an imported patch may touch. */
const IMPORT_SECTIONS: ReadonlySet<string> = new Set(['general', 'appearance', 'behavior', 'interaction', 'sound', 'companion']);
const IMPORT_GENERAL_KEYS: ReadonlySet<string> = new Set(['catName']);

export interface ProfileDialogs {
  /** The native save dialog; the chosen path, or null when cancelled. */
  chooseSavePath(defaultName: string): Promise<string | null>;
  /** The native open dialog (one file); the chosen path, or null when cancelled. */
  chooseOpenPath(): Promise<string | null>;
}

export type CappedRead = { ok: true; text: string } | { ok: false; reason: 'too-large' };

export interface ProfileFs {
  /**
   * Writes the file. With `createOnly` it never replaces an existing file: it rejects with an
   * error whose `code` is 'EEXIST' (node:fs flag 'wx').
   */
  writeText(filePath: string, text: string, opts?: { createOnly?: boolean }): Promise<void>;
  stat(filePath: string): Promise<{ isFile: boolean; size: number }>;
  /** Reads at most `maxBytes` (UTF-8); a longer file is reported as too large, never read whole. */
  readTextCapped(filePath: string, maxBytes: number): Promise<CappedRead>;
}

export interface ProfileTransferDeps {
  settings: Pick<SettingsStore, 'get' | 'patch'>;
  /** The live cat (sim.serialize()). */
  getCat: () => PersistedCat;
  /** Hands the computed cat to the simulation (and saves it); may throw, which undoes the settings. */
  adoptCat: (cat: PersistedCat) => void;
  dialogs: ProfileDialogs;
  fs: ProfileFs;
  app: { version: string; host: PlatformId };
  /** 32 lowercase hex digits from a CSPRNG (node:crypto randomBytes(16)). */
  newToken: () => string;
  /** Epoch ms: the export time, bornAt capping, savedAt. */
  wallClock: () => number;
  /** Monotonic ms: the pending token's age. */
  clock: () => number;
  /** The file name part of a path (node:path basename). */
  basename: (filePath: string) => string;
  logger: Logger;
}

export interface ProfileTransferService {
  exportToFile(req: { includeMemory: boolean }): Promise<ProfileExportResponse>;
  openForImport(senderId: number): Promise<ProfileOpenResponse>;
  applyImport(senderId: number, req: { token: string; parts: ProfileParts }): ProfileApplyResponse;
  /** Forgets a pending import (the settings window closed, or the app quits). */
  clearPending(): void;
  /** For diagnostics and tests: whether an import waits for confirmation. */
  readonly hasPending: boolean;
}

interface Pending {
  token: string;
  senderId: number;
  profile: GizeProfile;
  skipped: number;
  at: number;
}

/** An error's code (EACCES, ENOENT, ...), never its message: fs messages carry the path. */
function errorCode(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code.slice(0, 32);
  return err instanceof Error ? err.name.slice(0, 32) : 'Error';
}

/**
 * The chosen path with the profile extension when it has none (Linux dialogs do not add it). The
 * dialog's overwrite confirmation covered `filePath` only, so a changed path is created, never
 * replaced (exportToFile).
 */
export function withProfileExtension(filePath: string, basename: (p: string) => string): string {
  return basename(filePath).includes('.') ? filePath : `${filePath}.${PROFILE_FILE_EXTENSION}`;
}

/** Why an imported settings patch may not be committed, or null (defense in depth: applyProfile already builds it from allow-lists). */
export function rejectImportPatch(patch: SettingsPatch): string | null {
  const guard = rejectConsentBypass(patch) ?? rejectMainOwnedPatch(patch) ?? rejectMainOwnedFields(patch);
  if (guard !== null) return guard;
  for (const [section, values] of Object.entries(patch)) {
    if (!IMPORT_SECTIONS.has(section)) return `section ${section} is never imported`;
    if (values === null || typeof values !== 'object') return `section ${section} must be an object`;
    if (section === 'general' && Object.keys(values).some((k) => !IMPORT_GENERAL_KEYS.has(k))) return 'only the name is imported from general';
    if (section === 'behavior' && 'activityPreset' in values) return 'activityPreset is derived, never imported';
  }
  return null;
}

/** The patch that puts back what `patch` changed, from the settings before it. */
function undoPatch(before: Settings, patch: SettingsPatch): SettingsPatch {
  const undo: Record<string, Record<string, unknown>> = {};
  for (const [section, values] of Object.entries(patch)) {
    const prev = (before as unknown as Record<string, Record<string, unknown>>)[section];
    if (!prev || values === null || typeof values !== 'object') continue;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(values)) out[key] = Array.isArray(prev[key]) ? [...(prev[key] as unknown[])] : prev[key];
    undo[section] = out;
  }
  return undo;
}

export function createProfileTransferService(deps: ProfileTransferDeps): ProfileTransferService {
  const log = deps.logger;
  let dialogOpen = false;
  let pending: Pending | null = null;

  /**
   * Writes the export without replacing a file the user did not confirm. The path the dialog returned
   * is written as is (the dialog asked before an overwrite). A path main changed by adding the
   * extension is only created; when that file already exists, the exact path the user chose is
   * written instead. Returns the path written.
   */
  async function writeConfirmed(chosen: string, text: string): Promise<string> {
    const target = withProfileExtension(chosen, deps.basename);
    if (target === chosen) {
      await deps.fs.writeText(chosen, text);
      return chosen;
    }
    try {
      await deps.fs.writeText(target, text, { createOnly: true });
      return target;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
      log.info('profile export kept an existing file: wrote the name as chosen, without the added extension');
      await deps.fs.writeText(chosen, text);
      return chosen;
    }
  }

  async function exportToFile(req: { includeMemory: boolean }): Promise<ProfileExportResponse> {
    if (dialogOpen) return { status: 'busy' };
    dialogOpen = true;
    try {
      const prepared = prepareProfileExport(deps.settings.get(), deps.getCat(), {
        includeMemory: req.includeMemory === true,
        app: deps.app,
        now: deps.wallClock(),
      });
      if (!prepared.ok) {
        // A bug or a hand-edited cat file: never write a file this build could not load itself.
        log.warn('profile export refused by its self-check', { reason: prepared.reason, skipped: prepared.skipped.length });
        return { status: 'failed' };
      }
      const chosen = await deps.dialogs.chooseSavePath(prepared.fileName);
      if (chosen === null) return { status: 'cancelled' };
      let target: string;
      try {
        target = await writeConfirmed(chosen, prepared.text);
      } catch (err) {
        log.warn('profile export failed', { code: errorCode(err) });
        return { status: 'failed' };
      }
      log.info('profile exported', { includeMemory: req.includeMemory === true, format: `${prepared.profile.format.major}.${prepared.profile.format.minor}` });
      return { status: 'saved', fileName: deps.basename(target).slice(0, 255) };
    } finally {
      dialogOpen = false;
    }
  }

  async function openForImport(senderId: number): Promise<ProfileOpenResponse> {
    if (dialogOpen) return { status: 'busy' };
    dialogOpen = true;
    // One slot: opening another file forgets the previous preview.
    pending = null;
    try {
      const chosen = await deps.dialogs.chooseOpenPath();
      if (chosen === null) return { status: 'cancelled' };
      let read: CappedRead;
      try {
        const st = await deps.fs.stat(chosen);
        if (!st.isFile) return rejected('unreadable');
        if (st.size > MAX_PROFILE_BYTES) return rejected('too-large');
        read = await deps.fs.readTextCapped(chosen, MAX_PROFILE_BYTES);
      } catch (err) {
        log.warn('profile file could not be read', { code: errorCode(err) });
        return rejected('unreadable');
      }
      if (!read.ok) return rejected('too-large');
      const parsed = parseProfile(read.text);
      if (!parsed.ok) {
        log.info('profile rejected', { reason: parsed.reason, ...(parsed.formatMajor === undefined ? {} : { formatMajor: parsed.formatMajor }) });
        return parsed.formatMajor === undefined ? { status: 'rejected', reason: parsed.reason } : { status: 'rejected', reason: parsed.reason, formatMajor: parsed.formatMajor };
      }
      const preview = previewImport(parsed.profile, deps.settings.get(), deps.getCat(), parsed);
      const token = deps.newToken();
      if (!PROFILE_TOKEN_PATTERN.test(token)) {
        log.error('profile token has the wrong shape; import refused');
        return { status: 'unavailable' };
      }
      pending = { token, senderId, profile: parsed.profile, skipped: parsed.skipped.length, at: deps.clock() };
      log.info('profile opened', { format: `${parsed.profile.format.major}.${parsed.profile.format.minor}`, sameCat: preview.sameCat, skipped: parsed.skipped.length, changes: preview.changes.length });
      return { status: 'ready', token, preview };
    } finally {
      dialogOpen = false;
    }
  }

  function rejected(reason: 'unreadable' | 'too-large'): ProfileOpenResponse {
    log.info('profile rejected', { reason });
    return { status: 'rejected', reason };
  }

  function applyImport(senderId: number, req: { token: string; parts: ProfileParts }): ProfileApplyResponse {
    const p = pending;
    if (!p || p.senderId !== senderId || p.token !== req.token) return { ok: false, reason: 'expired' };
    if (deps.clock() - p.at > PROFILE_TOKEN_TTL_MS) {
      pending = null;
      return { ok: false, reason: 'expired' };
    }
    const before = deps.settings.get();
    const cat = deps.getCat();
    const sameCat = p.profile.cat.catId === cat.catId;
    const result = applyProfile(p.profile, req.parts, before, cat, { now: deps.wallClock() });
    if (!result.ok) {
      // Nothing was selected: the preview stays open and the same token may be used again.
      if (result.reason === 'nothing-selected') return { ok: false, reason: 'nothing-selected' };
      pending = null;
      log.warn('profile could not be applied', { reason: result.reason });
      return { ok: false, reason: 'failed' };
    }
    const refused = rejectImportPatch(result.patch);
    if (refused !== null) {
      pending = null;
      log.error('profile settings patch refused by the import guard');
      return { ok: false, reason: 'failed' };
    }
    const touchesSettings = Object.keys(result.patch).length > 0;
    if (touchesSettings) {
      const committed = deps.settings.patch(result.patch);
      if (!committed.ok) {
        pending = null;
        log.warn('profile settings could not be saved');
        return { ok: false, reason: 'failed' };
      }
    }
    if (result.catChanged) {
      try {
        deps.adoptCat(result.catState);
      } catch (err) {
        pending = null;
        if (touchesSettings) {
          const undone = deps.settings.patch(undoPatch(before, result.patch));
          if (!undone.ok) log.error('profile import: putting the settings back failed');
        }
        log.error('profile import: the cat could not be adopted; nothing was changed', { code: errorCode(err) });
        return { ok: false, reason: 'failed' };
      }
    }
    pending = null;
    log.info('profile imported', {
      parts: PROFILE_PARTS.filter((part) => result.parts[part]),
      format: `${p.profile.format.major}.${p.profile.format.minor}`,
      sameCat,
      catReplaced: result.catReplaced,
      skipped: p.skipped,
      keptOff: result.keptOff.length,
    });
    return { ok: true, name: deps.settings.get().general.catName, catReplaced: result.catReplaced, keptOff: [...result.keptOff] };
  }

  return {
    exportToFile,
    openForImport,
    applyImport,
    clearPending() {
      pending = null;
    },
    get hasPending() {
      return pending !== null;
    },
  };
}
