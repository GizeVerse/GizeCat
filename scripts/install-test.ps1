# Install/uninstall validation for the NSIS installer (per-user, no elevation).
# Installs silently into a temporary directory, smoke-tests the installed exe,
# uninstalls silently and verifies files, shortcuts and the uninstall registry entry
# are gone. User data of the test run lives in a temp userData dir.
#   node scripts/with-lock.mjs install-test -- powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$setup = Get-ChildItem (Join-Path $root 'release') -Filter 'Desktop-Cat-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw 'installer not found; run npm run package' }
$target = Join-Path $env:TEMP ("dcat-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
function Find-UninstallKey { Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -eq 'Desktop Cat' } }
$before = @(Find-UninstallKey).Count
$result = [ordered]@{ installer = $setup.Name; sizeMB = [math]::Round($setup.Length / 1MB, 1); preexistingInstall = $before }
if ($before -gt 0) { throw 'Desktop Cat is already installed for this user; refusing to touch an existing install' }

$p = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', "/D=$target") -Wait -PassThru
$result.installExitCode = $p.ExitCode
$exe = Join-Path $target 'DesktopCat.exe'
$result.installedExe = Test-Path $exe
$key = Find-UninstallKey
$result.uninstallEntry = [bool]$key
if ($key) {
  $props = Get-ItemProperty $key.PSPath
  $result.displayVersion = $props.DisplayVersion
  $result.installLocationMatches = ($props.InstallLocation -eq $target)
}
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Desktop Cat.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Desktop Cat.lnk'
$result.startMenuShortcut = Test-Path $startMenu
$result.desktopShortcut = Test-Path $desktop

if ($result.installedExe) {
  $smoke = & node (Join-Path $root 'scripts\smoke-packaged.mjs') $exe
  $result.smokeExitCode = $LASTEXITCODE
}

$uninstaller = Get-ChildItem $target -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($uninstaller) {
  $u = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S') -Wait -PassThru
  $result.uninstallExitCode = $u.ExitCode
  Start-Sleep -Seconds 4
}
$result.exeRemoved = -not (Test-Path $exe)
$result.uninstallEntryRemoved = (@(Find-UninstallKey).Count -eq 0)
$result.startMenuShortcutRemoved = -not (Test-Path $startMenu)
$result.desktopShortcutRemoved = -not (Test-Path $desktop)
if (Test-Path $target) { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }
$result | ConvertTo-Json
