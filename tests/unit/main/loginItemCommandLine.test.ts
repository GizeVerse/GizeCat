// Golden strings are the REAL Electron 44.9.3 probe results in docs/research/v1.1/startup.md §2.
import { describe, expect, it } from 'vitest';
import { LOGIN_ITEM_NAME } from '../../../src/main/lifecycle/loginItem';
import { addQuoteForArg, formatCommandLine, parseCommandLine, startupApprovedEnabled } from '../../../src/main/lifecycle/loginItemCommandLine';
import { FakeWindowsLogin, seededRandom, TASK_MANAGER_DISABLED } from './loginItemFakes';

const PROBE_EXE = 'C:\\Users\\Probe User\\AppData\\Local\\Programs\\Desktop Çat ğ 猫\\DesktopCat.exe';
const PROBE_ARGS = ['--launched-at-login', 'C:\\dir with space\\x', '"pre quoted"', 'tail\\', 'plain'];
const PROBE_GOLDEN = '"C:\\Users\\Probe User\\AppData\\Local\\Programs\\Desktop Çat ğ 猫\\DesktopCat.exe" --launched-at-login "C:\\dir with space\\x" "\\"pre quoted\\"" "tail\\\\" plain';

describe('Electron command-line formatting (AddQuoteForArg / FormatCommandLineString)', () => {
  it('matches the probed REG_SZ byte for byte, non-ASCII kept, 149 UTF-16 units', () => {
    const cmd = formatCommandLine(PROBE_EXE, PROBE_ARGS);
    expect(cmd).toBe(PROBE_GOLDEN);
    expect(cmd.length).toBe(149);
  });

  it('strips quotes around the path before quoting (pre-quoted path gives the same string) but not around arguments', () => {
    expect(formatCommandLine(`"${PROBE_EXE}"`, PROBE_ARGS)).toBe(PROBE_GOLDEN);
    expect(addQuoteForArg('"pre quoted"')).toBe('"\\"pre quoted\\""');
  });

  it('quotes only arguments with a space, backslash or quote; doubles backslashes before the closing quote', () => {
    expect(addQuoteForArg('--launched-at-login')).toBe('--launched-at-login');
    expect(addQuoteForArg('')).toBe('');
    expect(addQuoteForArg('C:\\a b\\')).toBe('"C:\\a b\\\\"');
    expect(addQuoteForArg('a\\\\"b')).toBe('"a\\\\\\\\\\"b"');
    expect(addQuoteForArg('x\\y')).toBe('"x\\y"');
  });

  it('registers the production entry for the default install path', () => {
    expect(formatCommandLine('C:\\Users\\Ada\\AppData\\Local\\Programs\\Desktop Cat\\DesktopCat.exe', ['--launched-at-login'])).toBe(
      '"C:\\Users\\Ada\\AppData\\Local\\Programs\\Desktop Cat\\DesktopCat.exe" --launched-at-login',
    );
  });
});

describe('CommandLineToArgvW parsing', () => {
  it('splits the probed command line back into the original argv', () => {
    expect(parseCommandLine(PROBE_GOLDEN)).toEqual([PROBE_EXE, ...PROBE_ARGS]);
  });

  it('applies the program-name rule: quoted up to the next quote without escapes, else up to a blank', () => {
    expect(parseCommandLine('"C:\\dir\\a.exe" x')).toEqual(['C:\\dir\\a.exe', 'x']);
    expect(parseCommandLine('C:\\Program Files\\a.exe --x')).toEqual(['C:\\Program', 'Files\\a.exe', '--x']);
    expect(parseCommandLine('"C:\\odd\\"rest')).toEqual(['C:\\odd\\', 'rest']);
    expect(parseCommandLine('   ')).toEqual([]);
    expect(parseCommandLine('  a.exe  ')).toEqual(['a.exe']);
  });

  it('handles backslash and quote escapes in later arguments', () => {
    expect(parseCommandLine('p a\\\\"b c"')).toEqual(['p', 'a\\b c']);
    expect(parseCommandLine('p a\\"b')).toEqual(['p', 'a"b']);
    expect(parseCommandLine('p "a""b"')).toEqual(['p', 'a"b']);
    expect(parseCommandLine('p ""')).toEqual(['p', '']);
    expect(parseCommandLine('p a\\\\b')).toEqual(['p', 'a\\\\b']);
  });

  it('round-trips random arguments through Electron quoting (seeded property)', () => {
    const rnd = seededRandom(0xc0ffee);
    const alphabet = ['a', 'Z', ' ', '\\', '"', '\t', 'ç', '猫', '-', '.'];
    for (let n = 0; n < 2000; n++) {
      const args = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () =>
        Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''),
      ).map((a) => a.replace(/\t/g, 'T'));
      const exe = `C:\\dir ${n}\\Desktop Cat.exe`;
      expect(parseCommandLine(formatCommandLine(exe, args))).toEqual([exe, ...args]);
    }
  });
});

describe('StartupApproved rule', () => {
  it('only 00… and 02 00… count as enabled', () => {
    expect(startupApprovedEnabled(new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(startupApprovedEnabled(new Uint8Array([0, 0, 0, 0]))).toBe(true);
    expect(startupApprovedEnabled(new Uint8Array(TASK_MANAGER_DISABLED))).toBe(false);
    expect(startupApprovedEnabled(new Uint8Array([0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(startupApprovedEnabled(new Uint8Array([0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(startupApprovedEnabled(new Uint8Array([0x02, 0x05]))).toBe(false);
  });
});

describe('FakeWindowsLogin mirrors the probed Electron behaviour', () => {
  const exe = 'C:\\Users\\Probe User\\AppData\\Local\\Programs\\Desktop Cat\\DesktopCat.exe';

  it('set writes the quoted command line under `name`; enabled:true deletes StartupApproved, which erases a Task Manager disable', () => {
    const w = new FakeWindowsLogin();
    w.taskManagerDisable();
    w.setLoginItemSettings({ openAtLogin: true, path: exe, args: ['--launched-at-login'], name: LOGIN_ITEM_NAME, enabled: true });
    expect(w.runText()).toBe(`"${exe}" --launched-at-login`);
    expect(w.approvedHex()).toBeNull();
  });

  it('enabled:false writes 03 + eleven zero bytes; openAtLogin:false deletes both values', () => {
    const w = new FakeWindowsLogin();
    w.setLoginItemSettings({ openAtLogin: true, path: exe, args: [], name: LOGIN_ITEM_NAME, enabled: false });
    expect(w.approvedHex()).toBe('030000000000000000000000');
    w.setLoginItemSettings({ openAtLogin: false, path: exe, args: [], name: LOGIN_ITEM_NAME, enabled: true });
    expect(w.runText()).toBeNull();
    expect(w.approvedHex()).toBeNull();
  });

  it('the getter (v1 isActive) misses an unquoted path with spaces; a quoted one matches but drops switch args', () => {
    const w = new FakeWindowsLogin();
    w.setLoginItemSettings({ openAtLogin: true, path: exe, args: ['--launched-at-login'], name: LOGIN_ITEM_NAME, enabled: true });
    const unquoted = w.getLoginItemSettings({ path: exe, args: ['--launched-at-login'] });
    expect(unquoted).toMatchObject({ openAtLogin: true, executableWillLaunchAtLogin: false, launchItems: [] });
    const quoted = w.getLoginItemSettings({ path: `"${exe}"`, args: ['--launched-at-login'] });
    expect(quoted.executableWillLaunchAtLogin).toBe(true);
    expect(quoted.launchItems).toEqual([{ name: LOGIN_ITEM_NAME, path: exe, args: [], scope: 'user', enabled: true }]);
  });

  it('the getter compares openAtLogin case-sensitively and only under the AppUserModelID', () => {
    const w = new FakeWindowsLogin();
    w.setLoginItemSettings({ openAtLogin: true, path: exe, args: [], name: LOGIN_ITEM_NAME, enabled: true });
    const lower = w.getLoginItemSettings({ path: `"${exe.toLowerCase()}"` });
    expect(lower.openAtLogin).toBe(false);
    expect(lower.launchItems).toHaveLength(1);
    const otherAumid = new FakeWindowsLogin('some.other.aumid');
    otherAumid.setLoginItemSettings({ openAtLogin: true, path: exe, args: [], name: LOGIN_ITEM_NAME, enabled: true });
    expect(otherAumid.getLoginItemSettings({ path: exe }).openAtLogin).toBe(false);
  });

  it('the getter reports StartupApproved 03+FILETIME, 03 and 06 as disabled while openAtLogin stays true; 02 and 00 as enabled', () => {
    const w = new FakeWindowsLogin();
    w.setLoginItemSettings({ openAtLogin: true, path: exe, args: [], name: LOGIN_ITEM_NAME, enabled: true });
    for (const bytes of [TASK_MANAGER_DISABLED, [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]) {
      w.setApproved(bytes);
      const r = w.getLoginItemSettings({ path: `"${exe}"` });
      expect([r.openAtLogin, r.launchItems[0]?.enabled]).toEqual([true, false]);
    }
    for (const bytes of [[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]) {
      w.setApproved(bytes);
      expect(w.getLoginItemSettings({ path: `"${exe}"` }).launchItems[0]?.enabled).toBe(true);
    }
  });
});
