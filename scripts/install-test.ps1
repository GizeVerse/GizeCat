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
# may create to a file before the first launch, and removes both values in finally. finally also
# uninstalls when the run stopped before its own uninstall step (an error, Ctrl+C), and removes
# the Uninstall entry, electron-builder's key and the shortcuts this run's install left behind.
#   node scripts/with-lock.mjs install-test -- powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-test.ps1 [-Arch x64|arm64] [-Installer <path>]
#
# 1.4.0: one installer per architecture. -Arch defaults to the PC's native architecture; the
# installer is exactly Desktop-Cat-Setup-<package.json version>-<arch>.exe in release\,
# release\<version>\ or release\<version>\windows\ (none or several copies is an error;
# -Installer names one by path). An x64
# installer may be tested on Windows 11 on Arm (x64 emulation); the arm64 installer refuses to
# run anywhere but Windows on Arm, so -Arch arm64 on an x64 PC is refused here.
param(
  [ValidateSet('x64', 'arm64')][string]$Arch,
  [string]$Installer
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Native architecture of Windows: PROCESSOR_ARCHITECTURE in Session Manager\Environment stays the
# native value (ARM64) even inside an emulated x64 PowerShell, unlike $env:PROCESSOR_ARCHITECTURE.
function Get-NativeArch {
  $v = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
  switch ($v) {
    'AMD64' { return 'x64' }
    'ARM64' { return 'arm64' }
    default { throw "unsupported Windows architecture: $v" }
  }
}
# The one installer under test (same function in upgrade-test.ps1).
function Resolve-Installer([string]$repoRoot, [string]$version, [string]$arch, [string]$explicit) {
  if ($explicit) {
    if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) { throw "installer not found: $explicit" }
    $item = Get-Item -LiteralPath $explicit
    if (($item.Name -match '-(x64|arm64)\.exe$') -and ($Matches[1] -ne $arch)) { throw "$($item.Name) is not the $arch installer" }
    return $item
  }
  $name = "Desktop-Cat-Setup-$version-$arch.exe"
  $release = Join-Path $repoRoot 'release'
  # release\ (npm run package:win), release\<version>\ (up to 1.3.0), release\<version>\windows\ (the 1.4.0 release run).
  $versioned = Join-Path $release $version
  $found = @(@($release, $versioned, (Join-Path $versioned 'windows')) | ForEach-Object { Join-Path $_ $name } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  if ($found.Count -eq 0) { throw "$name not found in release\, release\$version\ or release\$version\windows\; package it first (docs/RELEASE_CHECKLIST.md) or pass -Installer <path>" }
  if ($found.Count -gt 1) { throw "several copies of $name ($($found -join ', ')); pass -Installer <path>" }
  return Get-Item -LiteralPath $found[0]
}

$nativeArch = Get-NativeArch
if (-not $Arch) { $Arch = $nativeArch }
if (($Arch -eq 'arm64') -and ($nativeArch -ne 'arm64')) { throw 'the arm64 installer runs only on Windows on Arm (it stops on this PC by design); use -Arch x64' }
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$setup = Resolve-Installer $root $version $Arch $Installer

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
$uninstallerExe = Join-Path $target 'Uninstall DesktopCat.exe'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Desktop Cat.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Desktop Cat.lnk'

function Find-UninstallKey { Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -eq 'Desktop Cat' } }
function Test-UnderTarget([string]$path) {
  # Windows paths compare case-insensitively; a trailing backslash is not significant.
  $t = $target.TrimEnd('\')
  $ci = [System.StringComparison]::OrdinalIgnoreCase
  return [string]::Equals($path.TrimEnd('\'), $t, $ci) -or $path.StartsWith($t + '\', $ci)
}
# Keys this run's install created: the Uninstall entry whose uninstaller lives under $target, and
# electron-builder's own HKCU\Software\<app guid> key whose InstallLocation is $target.
function Find-OwnInstallKeys {
  @(Find-UninstallKey | Where-Object { [string](Get-ItemProperty $_.PSPath).UninstallString -match '^\s*"([^"]+)"' -and (Test-UnderTarget $Matches[1]) })
  @(Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | Where-Object {
      $loc = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).InstallLocation
      $loc -and (Test-UnderTarget ([string]$loc))
    })
}

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

function Get-LastReconcile {
  $last = @(Get-ReconcileLines) | Select-Object -Last 1
  if (-not $last) { return $null }
  return [ordered]@{ rule = $last.d.rule; gate = @($last.d.gate); state = $last.d.state; ok = $last.d.ok }
}
# Native tools through Start-Process: under $ErrorActionPreference = 'Stop', Windows PowerShell
# 5.1 turns a native command's redirected stderr into a terminating error.
function Stop-Tree([int]$procId) {
  $k = Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', "$procId", '/T', '/F') -WindowStyle Hidden -Wait -PassThru
  return $k.ExitCode
}

$started = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
function Start-App([string]$exe) {
  # Real launch as a user would start it: no test mode; DESKTOP_CAT_LOGIN_ITEM must not be 'off'.
  $env:DESKTOP_CAT_USER_DATA = $userData
  Remove-Item Env:\DESKTOP_CAT_LOGIN_ITEM -ErrorAction SilentlyContinue
  Remove-Item Env:\DESKTOP_CAT_TEST -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $exe -PassThru
  $started.Add($p)
  return $p
}
function Stop-App($p) {
  if ($p -and -not $p.HasExited) { $null = Stop-Tree $p.Id }
  if ($p) { $null = $p.WaitForExit(10000) }
  Start-Sleep -Milliseconds 800
}
function Wait-Reconciled([int]$count) { Wait-Until { (Get-ReconcileLines).Count -ge $count } 30 }

$before = @(Find-UninstallKey).Count
$result = [ordered]@{ installer = $setup.Name; arch = $Arch; nativeArch = $nativeArch; sizeMB = [math]::Round($setup.Length / 1MB, 1); preexistingInstall = $before; target = $target }
if ($before -gt 0) { throw 'Desktop Cat is already installed for this user; refusing to touch an existing install' }
if ($null -ne (Get-RunText)) { throw "HKCU\$runKey\$valueName already exists; refusing to touch a real startup entry" }
if ($null -ne (Get-LoginValue $approvedKey)) { throw "HKCU\$approvedKey\$valueName already exists; refusing to touch a real Startup apps record" }
$markerPreexisting = Test-Path $marker
# Shortcuts the cleanup may remove: only those this run's install creates.
$startMenuPreexisting = Test-Path $startMenu
$desktopPreexisting = Test-Path $desktop
$installed = $false
$appDataCreated = $false
$expectedRun = '"' + (Join-Path $target 'DesktopCat.exe') + '" --launched-at-login'
$disabledBytes = [byte[]](0x03, 0, 0, 0, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0x01)
$enabledBytes = [byte[]](0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

# Recorded before anything can write, so a dead run can still be cleaned up by hand.
[ordered]@{
  purpose = 'Desktop Cat install-test; remove these values (and run the uninstaller if it is still there) if this file is still here'
  values = @("HKCU\$runKey\$valueName", "HKCU\$approvedKey\$valueName")
  target = $target
  uninstaller = "`"$uninstallerExe`" /S"
  userData = $userData
  startedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Path $recordFile -Encoding utf8

$cleanupOk = $false
try {
  New-Item -ItemType Directory -Force $userData | Out-Null
  # Set first: from here on finally uninstalls, also after an error or Ctrl+C mid-install.
  $installed = $true
  $p = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', "/D=$target") -Wait -PassThru
  $result.installExitCode = $p.ExitCode
  $exe = Join-Path $target 'DesktopCat.exe'
  $result.installedExe = Test-Path $exe
  $key = Find-UninstallKey
  $result.uninstallEntry = [bool]$key
  if ($key) {
    $props = Get-ItemProperty $key.PSPath
    $result.displayVersion = $props.DisplayVersion
    # electron-builder 26 keeps InstallLocation under its own Software\<guid> key, not in the
    # Uninstall entry, so the location is checked through the uninstaller path the entry runs.
    $result.uninstallString = $props.UninstallString
    $uninstallDir = if ([string]$props.UninstallString -match '^\s*"([^"]+)"') { Split-Path -Parent $Matches[1] } else { $null }
    # Windows paths compare case-insensitively; a trailing backslash is not significant.
    $result.installLocationMatches = ($null -ne $uninstallDir) -and ($uninstallDir.TrimEnd('\') -ieq $target.TrimEnd('\'))
  }
  $result.startMenuShortcut = Test-Path $startMenu
  $result.desktopShortcut = Test-Path $desktop
  # The app's write gate requires the uninstaller next to the exe (UNINSTALLER_FILE in loginItem.ts).
  $result.installedFiles = @(Get-ChildItem -LiteralPath $target -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  # electron-builder: 'Uninstall <executableName>.exe' (uninstallerFileFor in loginItem.ts).
  $result.uninstallerNextToExe = Test-Path -LiteralPath (Join-Path $target 'Uninstall DesktopCat.exe')

  if ($result.installedExe) {
    # Smoke run with DESKTOP_CAT_LOGIN_ITEM=off: an installed copy must still leave the registry alone.
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $null = & node (Join-Path $root 'scripts\smoke-packaged.mjs') $exe 2>&1
      $result.smokeExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $eap }
    $result.smokeLeftRunAlone = ($null -eq (Get-RunText)) -and ($null -eq (Get-ApprovedHex))

    # 1. First start registers exactly "<target>\DesktopCat.exe" --launched-at-login, no StartupApproved value.
    $app = Start-App $exe
    $result.firstRegistered = Wait-Until { $null -ne (Get-RunText) } 30
    $null = Wait-Reconciled 1
    $null = Wait-Until { (Test-Path (Join-Path $userData 'settings.json')) -and ((Get-Content (Join-Path $userData 'settings.json') -Raw) -match '"registeredPath":\s*"') } 15
    $result.firstReconcile = Get-LastReconcile
    $result.firstRunText = Get-RunText
    $result.firstRunExact = ($result.firstRunText -ceq $expectedRun)
    $result.firstNoApproved = ($null -eq (Get-ApprovedHex))
    Stop-App $app

    # 2. A stale path (moved install) is repaired on the next start.
    Set-LoginValue $runKey ('"' + (Join-Path $env:TEMP ("dcat moved " + $rand)) + '\DesktopCat.exe" --launched-at-login') ([Microsoft.Win32.RegistryValueKind]::String)
    $app = Start-App $exe
    $result.staleRepaired = Wait-Until { (Get-RunText) -ceq $expectedRun } 30
    $null = Wait-Reconciled 2
    $result.staleReconcile = Get-LastReconcile
    Stop-App $app

    # 3. Disabled in Task Manager (03 + FILETIME): the next start leaves both values untouched.
    Set-LoginValue $approvedKey $disabledBytes ([Microsoft.Win32.RegistryValueKind]::Binary)
    $disabledHex = Get-ApprovedHex
    $app = Start-App $exe
    $result.disabledReconciled = Wait-Reconciled 3
    Start-Sleep -Seconds 2
    $result.disabledApprovedUntouched = ((Get-ApprovedHex) -eq $disabledHex)
    $result.disabledRunUntouched = ((Get-RunText) -ceq $expectedRun)
    $result.disabledReconcile = Get-LastReconcile
    $result.disabledRule = if ($result.disabledReconcile) { $result.disabledReconcile.rule } else { $null }
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

    # 5. Uninstall of an entry re-enabled in Startup apps (02 00..., still the value from step 4):
    #    both values go and the reinstall marker is left (the uninstaller reads the bytes with
    #    Electron's rule; every other StartupApproved case is covered by the compiled-harness
    #    test in tests/integration/win32/registry.real.test.ts).
  }

  $uninstaller = Get-ChildItem $target -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($uninstaller) {
    $u = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S') -Wait -PassThru
    $result.uninstallerName = $uninstaller.Name
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
} catch {
  $result.error = "$($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
} finally {
  # Every step runs even when an earlier one fails; failures are recorded, not thrown.
  $ErrorActionPreference = 'Continue'
  $cleanupErrors = New-Object System.Collections.Generic.List[string]
  $steps = [ordered]@{
    # Process objects keep their handle open, so a PID can never have been reused by another program.
    'stop launched apps' = { foreach ($sp in $started) { if (-not $sp.HasExited) { $null = Stop-Tree $sp.Id } } }
    'environment' = { Remove-Item Env:\DESKTOP_CAT_USER_DATA -ErrorAction SilentlyContinue }
    # A run that stopped between install and uninstall (an error, Ctrl+C) must not leave an Apps &
    # features entry, shortcuts or electron-builder's key behind: uninstall first, then leftovers.
    'uninstall' = {
      if ($installed -and (Test-Path -LiteralPath $uninstallerExe)) {
        $null = Start-Process -FilePath $uninstallerExe -ArgumentList @('/S') -Wait -PassThru
        # The NSIS uninstaller finishes from a temporary copy of itself.
        $result.cleanupUninstalled = Wait-Until { (-not (Test-Path -LiteralPath $uninstallerExe)) -and (@(Find-OwnInstallKeys).Count -eq 0) } 30
      }
    }
    'Run value' = { Remove-LoginValue $runKey }
    'StartupApproved value' = { Remove-LoginValue $approvedKey }
    'marker' = { if ((-not $markerPreexisting) -and (Test-Path $marker)) { Remove-Item -Force $marker } }
    'test app data' = { if ($appDataCreated -and (Test-Path $appData)) { Remove-Item -Recurse -Force $appData } }
    'install registry keys' = { if ($installed) { foreach ($k in @(Find-OwnInstallKeys)) { Remove-Item -LiteralPath $k.PSPath -Recurse -Force } } }
    'shortcuts' = {
      if ($installed -and (-not $startMenuPreexisting) -and (Test-Path -LiteralPath $startMenu)) { Remove-Item -LiteralPath $startMenu -Force }
      if ($installed -and (-not $desktopPreexisting) -and (Test-Path -LiteralPath $desktop)) { Remove-Item -LiteralPath $desktop -Force }
    }
    'install folder' = { if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force } }
    'user data' = { if (Test-Path -LiteralPath $userData) { Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath $userData -Recurse -Force } }
  }
  foreach ($step in $steps.GetEnumerator()) {
    try { & $step.Value } catch { $cleanupErrors.Add("$($step.Key): $($_.Exception.Message)") }
  }
  $result.cleanupRunGone = ($null -eq (Get-RunText))
  $result.cleanupApprovedGone = ($null -eq (Get-LoginValue $approvedKey))
  $result.cleanupInstallGone = (@(Find-OwnInstallKeys).Count -eq 0) -and (-not (Test-Path -LiteralPath $target))
  $result.cleanupErrors = @($cleanupErrors)
  $cleanupOk = $result.cleanupRunGone -and $result.cleanupApprovedGone -and $result.cleanupInstallGone
  # The record stays until both values and the install are confirmed gone.
  if ($cleanupOk) { Remove-Item -Force $recordFile -ErrorAction SilentlyContinue }
}

$upgradeDataOk = (-not $result.upgradeDataTested) -or ($result.userDataSurvivedUpgrade -and $result.userDataSurvivedUninstall)
$loginOk = $result.smokeLeftRunAlone -and $result.firstRegistered -and $result.firstRunExact -and $result.firstNoApproved -and `
  $result.staleRepaired -and $result.disabledReconciled -and $result.disabledApprovedUntouched -and $result.disabledRunUntouched -and `
  ($result.disabledRule -eq 'windows-disabled') -and $result.upgradeKeptRun -and $result.upgradeKeptApproved -and `
  $result.uninstallRemovedRun -and $result.uninstallRemovedApproved -and ((-not $result.markerChecked) -or $result.uninstallMarkerWritten)
$loginOk = $loginOk -and $result.uninstallerNextToExe
$result.loginOk = [bool]$loginOk
$result.ok = [bool]($loginOk -and $upgradeDataOk -and $cleanupOk -and ($result.installExitCode -eq 0) -and $result.installedExe -and $result.uninstallEntry -and `
  $result.installLocationMatches -and $result.startMenuShortcut -and $result.desktopShortcut -and ($result.smokeExitCode -eq 0) -and `
  ($result.upgradeExitCode -eq 0) -and $result.upgradeExePresent -and $result.upgradeSingleUninstallEntry -and `
  ($result.uninstallExitCode -eq 0) -and $result.exeRemoved -and $result.uninstallEntryRemoved -and `
  $result.startMenuShortcutRemoved -and $result.desktopShortcutRemoved -and (-not $result.error) -and ($result.cleanupErrors.Count -eq 0))
$result | ConvertTo-Json -Depth 6
if (-not $result.ok) { exit 1 }
