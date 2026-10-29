# REAL upgrade validation: v1.0.x installer -> current installer, with v1 settings.
# Installs the OLD release silently into a temporary folder with a space, plants a v1-shaped
# settings.json (launchAtLogin false, as every v1 file has) in a temporary userData folder,
# installs the NEW release over it, starts the new app once and checks that:
#   - the NSIS upgrade succeeds and leaves a single uninstall entry,
#   - settings migrate to schema v2 (loginItem section, user values kept),
#   - launch at sign-in is registered with exactly "<install>\DesktopCat.exe" --launched-at-login,
# then uninstalls and verifies the Run/StartupApproved values are gone. Cleans up in finally.
#   node scripts/with-lock.mjs upgrade-test -- powershell -NoProfile -ExecutionPolicy Bypass -File scripts/upgrade-test.ps1 -OldInstaller <path to Desktop-Cat-Setup-1.0.x.exe>
param([Parameter(Mandatory = $true)][string]$OldInstaller)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$new = Get-ChildItem (Join-Path $root 'release') -Filter 'Desktop-Cat-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $new) { throw 'new installer not found; run npm run package' }
if (-not (Test-Path $OldInstaller)) { throw "old installer not found: $OldInstaller" }
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
$result = [ordered]@{ oldInstaller = (Split-Path -Leaf $OldInstaller); newInstaller = $new.Name; target = $target }
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
  $null = Wait-Until { (Get-Content (Join-Path $userData 'settings.json') -Raw) -match '"schemaVersion":\s*2' } 20
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
  $result.registered -and $result.runExact -and $result.approvedAbsent -and ($result.schemaVersion -eq 2) -and $result.catNameKept -and `
  $result.skinKept -and $result.launchAtLoginFieldRemoved -and $li -and ($li.v1Value -eq $false) -and ($li.disabledBy -eq $null) -and `
  ($result.uninstallExitCode -eq 0) -and $result.uninstallRemovedRun -and $result.uninstallRemovedApproved -and $result.uninstallEntryRemoved
$result | ConvertTo-Json -Depth 4
if (-not $result.ok) { exit 1 }
