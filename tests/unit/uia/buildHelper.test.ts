// scripts/build-uia-helper.mjs: the stamp only ever describes an exe that passed the --version smoke
// check. MOCKED: csc.exe and the helper are a fake execFileSync, the .NET Framework directory is a
// temp folder; the real helper sources are hashed (read only).
import type * as ChildProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeDir, tempDir } from '../main/helpers';

/** What the fake helper does on --version: answer, crash at startup, or print garbage. */
type Smoke = 'ok' | 'crash' | 'garbage';

const exec = vi.hoisted(() => {
  const state: { smoke: Smoke; calls: string[] } = { smoke: 'ok', calls: [] };
  return state;
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[] = []) => {
      if (/csc\.exe$/i.test(file)) {
        exec.calls.push('csc');
        const out = args.find((a) => a.startsWith('/out:'));
        if (out === undefined) throw new Error('no /out:');
        fs.writeFileSync(out.slice('/out:'.length), 'MZ fake helper');
        return Buffer.alloc(0);
      }
      if (args[0] === '--version') {
        exec.calls.push(`version:${path.basename(file)}`);
        if (exec.smoke === 'crash') throw new Error('helper crashed at startup');
        // v1.2: the helper speaks protocol 2 (scripts/build-uia-helper.mjs HELPER_PROTOCOL_VERSION).
        return exec.smoke === 'garbage' ? 'not json\n' : '{"version":2,"dpi":"permonitorv2"}\n';
      }
      throw new Error(`unexpected execFileSync ${file}`);
    },
  };
});

interface BuildResult {
  ok: boolean;
  skipped: boolean;
  rebuilt: boolean;
  path: string | null;
}
type BuildFn = (o: { outDir: string; log: (m: string) => void }) => BuildResult;

/** Non-literal specifier: the .mjs script has no type declarations. */
const SCRIPT = '../../../scripts/build-uia-helper.mjs';

describe('build-uia-helper: smoke check and stamp', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const windir = process.env.WINDIR;
  let dir = '';
  let csc = '';
  let buildUiaHelper: BuildFn;

  beforeEach(async () => {
    dir = tempDir('dcat-uia-build-');
    const fw = path.join(dir, 'windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    fs.mkdirSync(path.join(fw, 'WPF'), { recursive: true });
    csc = path.join(fw, 'csc.exe');
    fs.writeFileSync(csc, '');
    for (const f of ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll']) fs.writeFileSync(path.join(fw, 'WPF', f), '');
    process.env.WINDIR = path.join(dir, 'windows');
    if (platform) Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    exec.smoke = 'ok';
    exec.calls.length = 0;
    ({ buildUiaHelper } = (await import(/* @vite-ignore */ SCRIPT)) as { buildUiaHelper: BuildFn });
  });

  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
    if (windir === undefined) delete process.env.WINDIR;
    else process.env.WINDIR = windir;
    removeDir(dir);
  });

  it('a helper that fails the check is neither kept nor stamped, so the next run compiles and checks it again', () => {
    const outDir = path.join(dir, 'out');
    const exe = path.join(outDir, 'DesktopCatUia.exe');
    const logs: string[] = [];
    const build = (): BuildResult => buildUiaHelper({ outDir, log: (m) => logs.push(m) });

    exec.smoke = 'crash';
    expect(build).toThrow(/smoke check \(helper crashed at startup\)/);
    // Nothing left behind: no exe, no stamp, no temp file.
    expect(fs.readdirSync(outDir)).toEqual([]);
    // Same sources: compiled and checked again (it used to report "up to date" and return ok).
    expect(build).toThrow(/smoke check/);
    expect(exec.calls.filter((c) => c === 'csc')).toHaveLength(2);
    exec.smoke = 'garbage';
    expect(build).toThrow(/smoke check/);
    expect(logs.some((l) => l.includes('up to date'))).toBe(false);
    expect(fs.readdirSync(outDir)).toEqual([]);

    exec.smoke = 'ok';
    expect(build()).toMatchObject({ ok: true, rebuilt: true, path: exe });
    expect(fs.readFileSync(exe, 'utf8')).toBe('MZ fake helper');
    expect(fs.readdirSync(outDir).sort()).toEqual(['DesktopCatUia.exe', 'DesktopCatUia.exe.stamp']);
    // The check ran on the new exe before it took the helper's place.
    expect(exec.calls.filter((c) => c.startsWith('version:')).every((c) => /^version:\.DesktopCatUia\.exe\.\d+\.tmp\.exe$/.test(c))).toBe(true);
    expect(build()).toMatchObject({ ok: true, rebuilt: false });
    expect(logs.at(-1)).toMatch(/up to date/);
  });

  it('a rebuild that fails the check removes the previous helper and its stamp', () => {
    const outDir = path.join(dir, 'out');
    const exe = path.join(outDir, 'DesktopCatUia.exe');
    const build = (): BuildResult => buildUiaHelper({ outDir, log: () => undefined });
    expect(build()).toMatchObject({ ok: true, rebuilt: true });
    // A different compiler changes the build hash: the next build compiles.
    fs.writeFileSync(csc, 'another compiler');
    exec.smoke = 'crash';
    expect(build).toThrow(/smoke check/);
    expect(fs.existsSync(exe)).toBe(false);
    expect(fs.existsSync(`${exe}.stamp`)).toBe(false);
    exec.smoke = 'ok';
    expect(build()).toMatchObject({ ok: true, rebuilt: true });
  });
});
