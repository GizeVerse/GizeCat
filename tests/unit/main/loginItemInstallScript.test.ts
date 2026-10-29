// scripts/install-test.ps1 (the packaged launch-at-sign-in check) must clean up an install it
// made even when it stops early (startup#6): an error or Ctrl+C between its install and its own
// uninstall step used to delete the install folder, uninstaller included, and leave the Apps &
// features entry, electron-builder's key and the shortcuts behind, so every later run refused to
// start. Static checks of the script (nothing is installed or run); the PowerShell parser reads
// its structure on Windows. MOCKED: no installer, no registry.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../../scripts/install-test.ps1');
const text = fs.readFileSync(SCRIPT, 'utf8');
const lines = text.split(/\r?\n/);
const lineOf = (re: RegExp): number => lines.findIndex((l) => re.test(l));

/** The script's own structure, read by the PowerShell parser (never executed). */
function parse(): { errors: string[]; steps: string[]; finallyText: string } {
  const ps = [
    '$tokens = $null; $errs = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:DCAT_INSTALL_TEST_SCRIPT, [ref]$tokens, [ref]$errs)',
    '$try = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.TryStatementAst] }, $false))[0]',
    '$table = @($try.Finally.FindAll({ param($n) $n -is [System.Management.Automation.Language.HashtableAst] }, $true))[0]',
    '@{ errors = @($errs | ForEach-Object { $_.Message }); steps = @($table.KeyValuePairs | ForEach-Object { $_.Item1.Value }); finallyText = $try.Finally.Extent.Text } | ConvertTo-Json -Compress',
  ].join('\n');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, DCAT_INSTALL_TEST_SCRIPT: SCRIPT },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  return JSON.parse(out) as { errors: string[]; steps: string[]; finallyText: string };
}

describe('install-test.ps1 cleanup after an early stop', () => {
  it('marks the install as made before the installer runs, inside the try that finally guards', () => {
    const tryLine = lineOf(/^try \{/);
    const flagOff = lineOf(/^\$installed = \$false/);
    const flagOn = lineOf(/^\s+\$installed = \$true/);
    const install = lineOf(/Start-Process -FilePath \$setup\.FullName/);
    expect(flagOff).toBeGreaterThan(-1);
    expect(flagOff).toBeLessThan(tryLine);
    expect(flagOn).toBeGreaterThan(tryLine);
    expect(flagOn).toBeLessThan(install);
  });

  it('records which shortcuts already existed before installing, so only its own are removed', () => {
    const install = lineOf(/Start-Process -FilePath \$setup\.FullName/);
    expect(lineOf(/^\$startMenuPreexisting = Test-Path \$startMenu/)).toBeLessThan(install);
    expect(lineOf(/^\$desktopPreexisting = Test-Path \$desktop/)).toBeLessThan(install);
    expect(lineOf(/^\$startMenu = /)).toBeLessThan(lineOf(/^\$startMenuPreexisting/));
  });

  it('the hand-cleanup record names the uninstaller', () => {
    expect(text).toMatch(/uninstaller = "`"\$uninstallerExe`" \/S"/);
  });

  it.runIf(process.platform === 'win32')(
    'finally uninstalls first and removes the install leftovers before deleting the install folder',
    () => {
      const { errors, steps, finallyText } = parse();
      expect(errors).toEqual([]);
      const at = (k: string): number => steps.indexOf(k);
      for (const k of ['uninstall', 'Run value', 'StartupApproved value', 'marker', 'install registry keys', 'shortcuts', 'install folder']) expect(at(k), k).toBeGreaterThan(-1);
      // The uninstaller lives in the install folder: it must run before that folder is deleted,
      // and the Run/StartupApproved values and the marker it may leave are removed after it.
      expect(at('uninstall')).toBeLessThan(at('install folder'));
      expect(at('uninstall')).toBeLessThan(at('Run value'));
      expect(at('uninstall')).toBeLessThan(at('marker'));
      expect(at('install registry keys')).toBeLessThan(at('install folder'));
      expect(at('shortcuts')).toBeLessThan(at('install folder'));
      // Each of those steps acts only on what this run installed.
      expect(finallyText).toMatch(/'uninstall' = \{\s*if \(\$installed -and \(Test-Path -LiteralPath \$uninstallerExe\)\)/);
      expect(finallyText).toMatch(/Start-Process -FilePath \$uninstallerExe -ArgumentList @\('\/S'\) -Wait/);
      expect(finallyText).toMatch(/'install registry keys' = \{ if \(\$installed\) \{ foreach \(\$k in @\(Find-OwnInstallKeys\)\)/);
      expect(finallyText).toMatch(/\$installed -and \(-not \$startMenuPreexisting\)/);
      expect(finallyText).toMatch(/\$installed -and \(-not \$desktopPreexisting\)/);
      // The run only counts as cleaned up (and its record file is deleted) once the install is gone too.
      expect(finallyText).toMatch(/\$cleanupOk = .*\$result\.cleanupInstallGone/);
    },
    90_000,
  );

  it('only keys whose uninstaller or install location lies under this run’s folder count as its own', () => {
    const fn = text.slice(text.indexOf('function Find-OwnInstallKeys'), text.indexOf('function Get-LoginValue'));
    expect(fn).toMatch(/UninstallString -match .*Test-UnderTarget \$Matches\[1\]/);
    expect(fn).toMatch(/InstallLocation[\s\S]*Test-UnderTarget/);
    // $target is a fresh folder with a random suffix, compared case-insensitively.
    expect(text).toMatch(/\$target = Join-Path \$env:TEMP \("dcat install " \+ \$rand\)/);
    expect(text).toMatch(/OrdinalIgnoreCase/);
  });
});
