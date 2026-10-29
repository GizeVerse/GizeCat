# Install/uninstall validation for the NSIS installer (per-user, no elevation).
# Installs silently into a temporary directory WITH A SPACE in its name, smoke-tests the
# installed exe, checks launch at sign-in end to end (first start registers the entry,
# a stale path is repaired, a Task Manager disable is left alone, an upgrade keeps the
# entry, the uninstaller removes it and leaves its reinstall marker), uninstalls silently
# and verifies files, shortcuts and registry entries are gone. App user data of the test
# launches lives in temp folders. Registry state is read with .NET (Microsoft.Win32.Registry),
# never by parsing reg.exe output (it mangles non-ASCII).
#
# The login item uses the production value name (that is what is under test), so the script
# refuses to run when that value (or its StartupApproved twin) already exists, records what it
# may create to a file before the first launch, and removes both values in finally.
#   node scripts/with-lock.mjs install-test -- powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$setup = Get-ChildItem (Join-Path $root 'release') -Filter 'Desktop-Cat-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw 'installer not found; run npm run package' }

$valueName = 'io.github.enesiltas.desktopcat'
$runKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
$approvedKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$rand = [guid]::NewGuid().ToString('N').Substring(0, 8)
$target = Join-Path $env:TEMP ("dcat install " + $rand)
$userData = Join-Path $env:TEMP ("dcat-install-ud-" + $rand)
$recordFile = Join-Path $env:TEMP ("dcat-install-test-" + $rand + ".json")
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$appData = Join-Path $env:APPDATA 'Desktop Cat'
$marker = Join-Path $appData 'login-item-removed-by-uninstall'

function Find-UninstallKey { Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -eq 'Desktop Cat' } }

function Get-LoginValue([string]$subKey) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey)
  if (-not $k) { return $null }
  try { return $k.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $k.Close() }
}
function Set-LoginValue([string]$subKey, $value, [Microsoft.Win32.RegistryValueKind]$kind) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey)
  try { $k.SetValue($valueName, $value, $kind) } finally { $k.Close() }
}
function Remove-LoginValue([string]$subKey) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey, $true)
  if (-not $k) { return }
  try { $k.DeleteValue($valueName, $false) } finally { $k.Close() }
}
function Get-RunText { Get-LoginValue $runKey }
function Get-ApprovedHex {
  $v = Get-LoginValue $approvedKey
  if ($null -eq $v) { return $null }
  return (($v | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Wait-Until([scriptblock]$condition, [int]$timeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (& $condition) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return [bool](& $condition)
}
function Get-ReconcileLines {
  $log = Join-Path $userData 'logs\main.log'
  if (-not (Test-Path $log)) { return @() }
  return @(Get-Content $log -Encoding utf8 | Where-Object { $_ -match '"m":"login item reconciled"' } | ForEach-Object { $_ | ConvertFrom-Json })
}

$started = New-Object System.Collections.Generic.List[int]
function Start-App([string]$exe) {
  # Real launch as a user would start it: no test mode; DESKTOP_CAT_LOGIN_ITEM must not be 'off'.
  $env:DESKTOP_CAT_USER_DATA = $userData
  Remove-Item Env:\DESKTOP_CAT_LOGIN_ITEM -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $exe -PassThru
  $started.Add($p.Id)
  return $p
}
function Stop-App($p) {
  if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F | Out-Null }
  if ($p) { $null = $p.WaitForExit(10000) }
  Start-Sleep -Milliseconds 800
}
function Wait-Reconciled([int]$count) { Wait-Until { (Get-ReconcileLines).Count -ge $count } 30 }

$before = @(Find-UninstallKey).Count
$result = [ordered]@{ installer = $setup.Name; sizeMB = [math]::Round($setup.Length / 1MB, 1); preexistingInstall = $before; target = $target }
if ($before -gt 0) { throw 'Desktop Cat is already installed for this user; refusing to touch an existing install' }
if ($null -ne (Get-RunText)) { throw "HKCU\$runKey\$valueName already exists; refusing to touch a real startup entry" }
if ($null -ne (Get-LoginValue $approvedKey)) { throw "HKCU\$approvedKey\$valueName already exists; refusing to touch a real Startup apps record" }
$markerPreexisting = Test-Path $marker
$appDataCreated = $false
$expectedRun = '"' + (Join-Path $target 'DesktopCat.exe') + '" --launched-at-login'
$disabledBytes = [byte[]](0x03, 0, 0, 0, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0x01)
$enabledBytes = [byte[]](0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

# Recorded before anything can write, so a dead run can still be cleaned up by hand.
[ordered]@{
  purpose = 'Desktop Cat install-test; remove these values if this file is still here'
  values = @("HKCU\$runKey\$valueName", "HKCU\$approvedKey\$valueName")
  target = $target
  userData = $userData
  startedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Path $recordFile -Encoding utf8

$cleanupOk = $false
try {
  New-Item -ItemType Directory -Force $userData | Out-Null
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
    # Smoke run with DESKTOP_CAT_LOGIN_ITEM=off: an installed copy must still leave the registry alone.
    $smoke = & node (Join-Path $root 'scripts\smoke-packaged.mjs') $exe
    $result.smokeExitCode = $LASTEXITCODE
    $result.smokeLeftRunAlone = ($null -eq (Get-RunText)) -and ($null -eq (Get-ApprovedHex))

    # 1. First start registers exactly "<target>\DesktopCat.exe" --launched-at-login, no StartupApproved value.
    $app = Start-App $exe
    $result.firstRegistered = Wait-Until { $null -ne (Get-RunText) } 30
    $null = Wait-Until { (Test-Path (Join-Path $userData 'settings.json')) -and ((Get-Content (Join-Path $userData 'settings.json') -Raw) -match '"registeredPath":\s*"') } 15
    $result.firstRunText = Get-RunText
    $result.firstRunExact = ($result.firstRunText -ceq $expectedRun)
    $result.firstNoApproved = ($null -eq (Get-ApprovedHex))
    Stop-App $app

    # 2. A stale path (moved install) is repaired on the next start.
    Set-LoginValue $runKey ('"' + (Join-Path $env:TEMP ("dcat moved " + $rand)) + '\DesktopCat.exe" --launched-at-login') ([Microsoft.Win32.RegistryValueKind]::String)
    $app = Start-App $exe
    $result.staleRepaired = Wait-Until { (Get-RunText) -ceq $expectedRun } 30
    $null = Wait-Reconciled 2
    Stop-App $app

    # 3. Disabled in Task Manager (03 + FILETIME): the next start leaves both values untouched.
    Set-LoginValue $approvedKey $disabledBytes ([Microsoft.Win32.RegistryValueKind]::Binary)
    $disabledHex = Get-ApprovedHex
    $app = Start-App $exe
    $result.disabledReconciled = Wait-Reconciled 3
    Start-Sleep -Seconds 2
    $result.disabledApprovedUntouched = ((Get-ApprovedHex) -eq $disabledHex)
    $result.disabledRunUntouched = ((Get-RunText) -ceq $expectedRun)
    $last = @(Get-ReconcileLines) | Select-Object -Last 1
    $result.disabledRule = if ($last) { $last.d.rule } else { $null }
    Stop-App $app

    # 4. Silent upgrade in place: the entry (and Task Manager's record) survive; user data survives
    #    when the real per-user data folder did not exist (no real user data is ever touched).
    Set-LoginValue $approvedKey $enabledBytes ([Microsoft.Win32.RegistryValueKind]::Binary)
    $result.upgradeDataTested = $false
    $upgradeMarker = '{"schemaVersion":1,"general":{"catName":"UpgradeMarker"}}'
    if (-not (Test-Path $appData)) {
      New-Item -ItemType Directory -Force $appData | Out-Null
      $appDataCreated = $true
      Set-Content -Path (Join-Path $appData 'settings.json') -Value $upgradeMarker -Encoding utf8 -NoNewline
      $result.upgradeDataTested = $true
    }
    $p2 = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', "/D=$target") -Wait -PassThru
    $result.upgradeExitCode = $p2.ExitCode
    $result.upgradeExePresent = Test-Path $exe
    $result.upgradeSingleUninstallEntry = (@(Find-UninstallKey).Count -eq 1)
    $result.upgradeKeptRun = ((Get-RunText) -ceq $expectedRun)
    $result.upgradeKeptApproved = ((Get-ApprovedHex) -eq (($enabledBytes | ForEach-Object { $_.ToString('x2') }) -join ''))
    if ($result.upgradeDataTested) {
      $result.userDataSurvivedUpgrade = (Test-Path (Join-Path $appData 'settings.json')) -and ((Get-Content (Join-Path $appData 'settings.json') -Raw) -eq $upgradeMarker)
    }

    # 5. Uninstall of an entry Startup apps never toggled: both values go, the reinstall marker is left.
    Remove-LoginValue $approvedKey
  }

  $uninstaller = Get-ChildItem $target -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($uninstaller) {
    $u = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S') -Wait -PassThru
    $result.uninstallExitCode = $u.ExitCode
    Start-Sleep -Seconds 4
  }
  $result.exeRemoved = -not (Test-Path (Join-Path $target 'DesktopCat.exe'))
  $result.uninstallEntryRemoved = (@(Find-UninstallKey).Count -eq 0)
  $result.startMenuShortcutRemoved = -not (Test-Path $startMenu)
  $result.desktopShortcutRemoved = -not (Test-Path $desktop)
  $result.uninstallRemovedRun = ($null -eq (Get-RunText))
  $result.uninstallRemovedApproved = ($null -eq (Get-ApprovedHex))
  $result.markerChecked = (-not $markerPreexisting) -and (Test-Path $appData)
  if ($result.markerChecked) { $result.uninstallMarkerWritten = Test-Path $marker }
  if ($result.upgradeDataTested) { $result.userDataSurvivedUninstall = Test-Path (Join-Path $appData 'settings.json') }
} finally {
  foreach ($procId in $started) { & taskkill /PID $procId /T /F 2>$null | Out-Null }
  Remove-Item Env:\DESKTOP_CAT_USER_DATA -ErrorAction SilentlyContinue
  Remove-LoginValue $runKey
  Remove-LoginValue $approvedKey
  $result.cleanupRunGone = ($null -eq (Get-RunText))
  $result.cleanupApprovedGone = ($null -eq (Get-LoginValue $approvedKey))
  if ((-not $markerPreexisting) -and (Test-Path $marker)) { Remove-Item -Force $marker -ErrorAction SilentlyContinue }
  if ($appDataCreated) { Remove-Item -Recurse -Force $appData -ErrorAction SilentlyContinue }
  if (Test-Path $target) { Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue }
  if (Test-Path $userData) { Remove-Item -Recurse -Force $userData -ErrorAction SilentlyContinue }
  $cleanupOk = $result.cleanupRunGone -and $result.cleanupApprovedGone
  if ($cleanupOk) { Remove-Item -Force $recordFile -ErrorAction SilentlyContinue }
}

$upgradeDataOk = (-not $result.upgradeDataTested) -or ($result.userDataSurvivedUpgrade -and $result.userDataSurvivedUninstall)
$loginOk = $result.smokeLeftRunAlone -and $result.firstRegistered -and $result.firstRunExact -and $result.firstNoApproved -and `
  $result.staleRepaired -and $result.disabledReconciled -and $result.disabledApprovedUntouched -and $result.disabledRunUntouched -and `
  ($result.disabledRule -eq 'windows-disabled') -and $result.upgradeKeptRun -and $result.upgradeKeptApproved -and `
  $result.uninstallRemovedRun -and $result.uninstallRemovedApproved -and ((-not $result.markerChecked) -or $result.uninstallMarkerWritten)
$result.loginOk = [bool]$loginOk
$result.ok = [bool]($loginOk -and $upgradeDataOk -and $cleanupOk -and ($result.installExitCode -eq 0) -and $result.installedExe -and $result.uninstallEntry -and `
  $result.installLocationMatches -and $result.startMenuShortcut -and $result.desktopShortcut -and ($result.smokeExitCode -eq 0) -and `
  ($result.upgradeExitCode -eq 0) -and $result.upgradeExePresent -and $result.upgradeSingleUninstallEntry -and `
  ($result.uninstallExitCode -eq 0) -and $result.exeRemoved -and $result.uninstallEntryRemoved -and `
  $result.startMenuShortcutRemoved -and $result.desktopShortcutRemoved)
$result | ConvertTo-Json
if (-not $result.ok) { exit 1 }
