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

# Upgrade in place: user data must survive installing over an existing install (and the
# later uninstall). Uses the app's real per-user data folder ONLY if it does not exist yet
# (so no real user data is ever touched) and deletes the marker folder at the end.
$appData = Join-Path $env:APPDATA 'Desktop Cat'
$result.upgradeTested = $false
if ($result.installedExe -and -not (Test-Path $appData)) {
  New-Item -ItemType Directory -Force $appData | Out-Null
  $marker = '{"schemaVersion":1,"general":{"catName":"UpgradeMarker"}}'
  Set-Content -Path (Join-Path $appData 'settings.json') -Value $marker -Encoding utf8 -NoNewline
  $p2 = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', "/D=$target") -Wait -PassThru
  $result.upgradeExitCode = $p2.ExitCode
  $result.upgradeExePresent = Test-Path $exe
  $result.upgradeSingleUninstallEntry = (@(Find-UninstallKey).Count -eq 1)
  $result.userDataSurvivedUpgrade = (Test-Path (Join-Path $appData 'settings.json')) -and ((Get-Content (Join-Path $appData 'settings.json') -Raw) -eq $marker)
  $result.upgradeTested = $true
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
if ($result.upgradeTested) {
  $result.userDataSurvivedUninstall = Test-Path (Join-Path $appData 'settings.json')
  Remove-Item -Recurse -Force $appData -ErrorAction SilentlyContinue
}
$upgradeOk = (-not $result.upgradeTested) -or (($result.upgradeExitCode -eq 0) -and $result.upgradeExePresent -and $result.upgradeSingleUninstallEntry -and $result.userDataSurvivedUpgrade -and $result.userDataSurvivedUninstall)
$result.ok = $upgradeOk -and ($result.installExitCode -eq 0) -and $result.installedExe -and $result.uninstallEntry -and `
  $result.startMenuShortcut -and $result.desktopShortcut -and ($result.smokeExitCode -eq 0) -and `
  ($result.uninstallExitCode -eq 0) -and $result.exeRemoved -and $result.uninstallEntryRemoved -and `
  $result.startMenuShortcutRemoved -and $result.desktopShortcutRemoved
$result | ConvertTo-Json
if (-not $result.ok) { exit 1 }
