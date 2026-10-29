// Windows command-line and StartupApproved rules for the launch-at-sign-in entry,
// ported from Electron 44.9.3 (shell/common/command_line_util_win.cc, shell/browser/
// browser_win.cc) and CommandLineToArgvW. Pure; see docs/research/v1.1/startup.md §2.

/** Microsoft: a Run command line must be at most 260 characters. */
export const MAX_RUN_COMMAND_CHARS = 260;

/** Registry value types this module distinguishes (winnt.h). */
export const REG_SZ = 1;
export const REG_EXPAND_SZ = 2;
export const REG_BINARY = 3;

/**
 * Electron's AddQuoteForArg: an argument containing a space, a backslash or a double quote
 * is quoted following CommandLineToArgvW rules (quotes become \", backslash runs before a
 * quote or the end are doubled). Anything else is returned as is (an empty string stays empty).
 */
export function addQuoteForArg(arg: string): string {
  if (!/[ \\"]/.test(arg)) return arg;
  let out = '"';
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (ch === '\\') {
      let end = i + 1;
      while (end < arg.length && arg[end] === '\\') end++;
      let count = end - i;
      if (end === arg.length || arg[end] === '"') count *= 2;
      out += '\\'.repeat(count);
      i = end - 1;
    } else if (ch === '"') {
      out += '\\"';
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

/**
 * Electron's FormatCommandLineString: the command line setLoginItemSettings writes for
 * `exe` and `args`. Surrounding quotes are stripped from the path (not from arguments)
 * before quoting.
 */
export function formatCommandLine(exe: string, args: readonly string[]): string {
  const bare = exe.length >= 2 && exe.startsWith('"') && exe.endsWith('"') ? exe.slice(1, -1) : exe;
  let out = addQuoteForArg(bare);
  for (const arg of args) out += ` ${addQuoteForArg(arg)}`;
  return out;
}

const isBlank = (ch: string | undefined): boolean => ch === ' ' || ch === '\t';

/**
 * Splits a command line the way CommandLineToArgvW does (the program name follows its own
 * rule: quoted up to the next quote with no escapes, else up to the first blank). Like
 * Chromium's CommandLine::FromString, surrounding whitespace is trimmed first, and an
 * empty line yields no program at all.
 */
export function parseCommandLine(commandLine: string): string[] {
  const s = commandLine.trim();
  if (s === '') return [];
  const argv: string[] = [];
  let i = 0;
  let program = '';
  if (s[0] === '"') {
    i = 1;
    while (i < s.length && s[i] !== '"') program += s[i++];
    if (s[i] === '"') i++;
  } else {
    while (i < s.length && !isBlank(s[i])) program += s[i++];
  }
  argv.push(program);
  while (isBlank(s[i])) i++;

  // Remaining arguments (Wine's model of the post-2008 behaviour).
  let current = '';
  let inArg = false;
  let quotes = 0;
  let backslashes = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    if (isBlank(ch) && quotes === 0) {
      argv.push(current);
      current = '';
      inArg = false;
      backslashes = 0;
      while (isBlank(s[i])) i++;
      continue;
    }
    inArg = true;
    if (ch === '\\') {
      current += ch;
      backslashes++;
      i++;
    } else if (ch === '"') {
      if (backslashes % 2 === 0) {
        current = current.slice(0, current.length - backslashes / 2);
        quotes++;
      } else {
        current = `${current.slice(0, current.length - (backslashes - 1) / 2 - 1)}"`;
      }
      i++;
      backslashes = 0;
      while (s[i] === '"') {
        if (++quotes === 3) {
          current += '"';
          quotes = 0;
        }
        i++;
      }
      if (quotes === 2) quotes = 0;
    } else {
      current += ch;
      backslashes = 0;
      i++;
    }
  }
  if (inArg) argv.push(current);
  return argv;
}

/**
 * Electron's StartupApproved rule: a value enables the entry only when its bytes, read as a
 * C string, equal "" or "\x02" (first byte 00, or 02 followed by 00). Everything else,
 * including Task Manager's 03 + FILETIME, means disabled. A missing value is handled by the
 * caller (it means enabled).
 */
export function startupApprovedEnabled(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes[0] === 0x00) return true;
  return bytes[0] === 0x02 && (bytes.length === 1 || bytes[1] === 0x00);
}

/** Windows paths compare case-insensitively (ordinal, invariant). */
export function samePath(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** Lower-cased file name of a Windows path. */
export function windowsBasename(p: string): string {
  const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return p.slice(cut + 1).toLowerCase();
}
