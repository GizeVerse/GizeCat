# REAL upgrade validation: v1.0.x installer -> current installer, with v1 settings.
# Installs the OLD release silently into a temporary folder with a space, plants a v1-shaped
# settings.json (launchAtLogin false, as every v1 file has) in a temporary userData folder,
# installs the NEW release over it, starts the new app once and checks that:
#   - the NSIS upgrade succeeds and leaves a single uninstall entry,
#   - settings migrate to schema v2 (loginItem section, user values kept),
#   - launch at sign-in is registered with exactly "<install>\DesktopCat.exe" --launched-at-login,
# then uninstalls and verifies the Run/StartupApproved values are gone. Cleans up in finally.
#   node scripts/with-lock.mjs upgrade-test -- powershell -NoProfile -ExecutionPolicy Bypass -File scripts/upgrade-test.ps1 -OldInstaller <path to Desktop-Cat-Setup-1.0.x.exe> [-Arch x64|arm64] [-Installer <path to the new installer>]
#
# 1.4.0: the NEW installer is chosen like install-test.ps1 does (exactly
# Desktop-Cat-Setup-<package.json version>-<arch>.exe in release\, release\<version>\ or
# release\<version>\windows\, -Arch
# defaulting to the PC's native architecture), never by file date. Installers up to 1.3.0 have no
# architecture suffix and are all x64. On a Windows on Arm PC the cross-architecture upgrade is
# -OldInstaller Desktop-Cat-Setup-1.3.0.exe (x64) -Arch arm64: the same appId, so NSIS treats it
# as an upgrade of the same app (the result records both architectures).
param(
  [Parameter(Mandatory = $true)][string]$OldInstaller,
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
# The one installer under test (same function in install-test.ps1).
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
$new = Resolve-Installer $root $version $Arch $Installer
if (-not (Test-Path $OldInstaller)) { throw "old installer not found: $OldInstaller" }
$oldArch = if ((Split-Path -Leaf $OldInstaller) -match '-(x64|arm64)\.exe$') { $Matches[1] } else { 'x64' }
if (($oldArch -eq 'arm64') -and ($nativeArch -ne 'arm64')) { throw 'the old installer is arm64 and cannot run on this PC' }
$valueName = 'io.github.enesiltas.desktopcat'
$runKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
$approvedKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
function Get-Value([string]$key) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key)
  if ($null -eq $k) { return $null }
  try { return $k.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $k.Close() }
}
function Remove-Value([string]$key) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key, $true)
  if ($null -ne $k) { try { $k.DeleteValue($valueName, $false) } finally { $k.Close() } }
}
function Find-UninstallKey { @(Get-ChildItem $uninstallRoot -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -eq 'Desktop Cat' }) }
function Wait-Until([scriptblock]$cond, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 250 }
  return $false
}

$rand = [guid]::NewGuid().ToString('N').Substring(0, 8)
$target = Join-Path $env:TEMP ("dcat upgrade " + $rand)
$userData = Join-Path $env:TEMP ("dcat-upgrade-data-" + $rand)
$exe = Join-Path $target 'DesktopCat.exe'
$expectedRun = '"' + $exe + '" --launched-at-login'
$result = [ordered]@{ oldInstaller = (Split-Path -Leaf $OldInstaller); oldArch = $oldArch; newInstaller = $new.Name; newArch = $Arch; crossArch = ($oldArch -ne $Arch); nativeArch = $nativeArch; target = $target }
if ((Find-UninstallKey).Count -gt 0) { throw 'Desktop Cat is already installed for this user; refusing to touch an existing install' }
if ($null -ne (Get-Value $runKey)) { throw 'a Desktop Cat startup entry already exists; refusing to touch it' }
$appProc = $null
try {
  $p = Start-Process -FilePath $OldInstaller -ArgumentList @('/S', "/D=$target") -Wait -PassThru
  $result.oldInstallExitCode = $p.ExitCode
  $result.oldVersion = (Find-UninstallKey | ForEach-Object { (Get-ItemProperty $_.PSPath).DisplayVersion }) -join ','

  # What every v1 settings file looks like: the whole object, launchAtLogin always written (false by default).
  New-Item -ItemType Directory -Force $userData | Out-Null
  $v1 = '{"schemaVersion":1,"general":{"catName":"UpgradeCat","launchAtLogin":false,"shortcutsEnabled":true,"toggleShortcut":"Control+Alt+Shift+C","firstRunCompleted":true},"appearance":{"skin":"tuxedo"}}'
  [IO.File]::WriteAllText((Join-Path $userData 'settings.json'), $v1)

  $p = Start-Process -FilePath $new.FullName -ArgumentList @('/S', "/D=$target") -Wait -PassThru
  $result.upgradeExitCode = $p.ExitCode
  $keys = Find-UninstallKey
  $result.singleUninstallEntry = ($keys.Count -eq 1)
  $result.newVersion = ($keys | ForEach-Object { (Get-ItemProperty $_.PSPath).DisplayVersion }) -join ','

  $env:DESKTOP_CAT_USER_DATA = $userData
  Remove-Item Env:DESKTOP_CAT_LOGIN_ITEM -ErrorAction SilentlyContinue
  $appProc = Start-Process -FilePath $exe -PassThru
  $result.registered = Wait-Until { $null -ne (Get-Value $runKey) } 40
  $result.runValue = Get-Value $runKey
  $result.runExact = ($result.runValue -ceq $expectedRun)
  $result.approvedAbsent = ($null -eq (Get-Value $approvedKey))
  $null = Wait-Until { (Get-Content (Join-Path $userData 'settings.json') -Raw) -match '"schemaVersion":\s*3' } 20
  $settings = Get-Content (Join-Path $userData 'settings.json') -Raw | ConvertFrom-Json
  $result.schemaVersion = $settings.schemaVersion
  $result.catNameKept = ($settings.general.catName -eq 'UpgradeCat')
  $result.skinKept = ($settings.appearance.skin -eq 'tuxedo')
  $result.launchAtLoginFieldRemoved = ($null -eq $settings.general.launchAtLogin)
  $result.loginItem = $settings.loginItem
} finally {
  if ($appProc -and -not $appProc.HasExited) { Start-Process -FilePath 'taskkill' -ArgumentList @('/PID', $appProc.Id, '/T', '/F') -WindowStyle Hidden -Wait | Out-Null }
  Remove-Item Env:DESKTOP_CAT_USER_DATA -ErrorAction SilentlyContinue
  $uninstaller = Get-ChildItem $target -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($uninstaller) {
    $u = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S') -Wait -PassThru
    $result.uninstallExitCode = $u.ExitCode
    Start-Sleep -Seconds 4
  }
  $result.uninstallRemovedRun = ($null -eq (Get-Value $runKey))
  $result.uninstallRemovedApproved = ($null -eq (Get-Value $approvedKey))
  $result.uninstallEntryRemoved = ((Find-UninstallKey).Count -eq 0)
  # Safety net: remove a value that still points into our temporary install only.
  $left = Get-Value $runKey
  if ($left -and $left.Contains($target)) { Remove-Value $runKey; Remove-Value $approvedKey }
  foreach ($d in @($target, $userData)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }
}
$li = $result.loginItem
$result.ok = ($result.oldInstallExitCode -eq 0) -and ($result.upgradeExitCode -eq 0) -and $result.singleUninstallEntry -and `
  $result.registered -and $result.runExact -and $result.approvedAbsent -and ($result.schemaVersion -eq 3) -and $result.catNameKept -and `
  $result.skinKept -and $result.launchAtLoginFieldRemoved -and $li -and ($li.v1Value -eq $false) -and ($li.disabledBy -eq $null) -and `
  ($result.uninstallExitCode -eq 0) -and $result.uninstallRemovedRun -and $result.uninstallRemovedApproved -and $result.uninstallEntryRemoved
$result | ConvertTo-Json -Depth 4
if (-not $result.ok) { exit 1 }
