<#
.SYNOPSIS
  OWNER TOOL. Creates GizeCat's Android upload key once, outside the repository, and prints only
  public facts about it. Agents never run it.

.DESCRIPTION
  Runs Android Studio's keytool interactively. keytool itself asks for the password (twice) and for
  the certificate's name fields; this script never sees, stores or prints the password. Use details
  you are willing to publish: they are readable by anyone who has the app.

  Refusals (nothing is overwritten, nothing is rotated):
  - the keystore file already exists;
  - the target folder is inside this repository;
  - keytool is not found.

  Results, all outside the repository, in %USERPROFILE%\.gizecat-keys by default:
  - <Name>.jks             the PKCS12 keystore with the private key: SECRET, back it up offline
  - <Name>-upload-cert.pem the public certificate, for Google Play's upload key steps
  - <Name>-README.txt      public facts: alias, path, SHA-256 and SHA-1 fingerprints, creation date

  The next steps (back up, configure signing, GitHub environment, Play App Signing) are in
  docs/platforms/android-signing.md.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\android-create-upload-key.ps1
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')] [string] $Name = 'gizecat-upload',
  [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')] [string] $Alias = 'gizecat-upload',
  [string] $Directory = (Join-Path $env:USERPROFILE '.gizecat-keys'),
  [string] $Keytool
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not $Keytool) {
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'Android\Android Studio\jbr\bin\keytool.exe'),
    $(if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\keytool.exe' })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $Keytool = $candidates | Select-Object -First 1
}
if (-not $Keytool -or -not (Test-Path -LiteralPath $Keytool)) { throw 'keytool.exe not found: install Android Studio, or pass -Keytool <path to keytool.exe>' }

$dirFull = [IO.Path]::GetFullPath($Directory)
if ($dirFull.TrimEnd('\').StartsWith($repo.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
  throw "refused: $dirFull is inside the repository ($repo). The keystore must live outside it."
}
$keystore = Join-Path $dirFull "$Name.jks"
$pem = Join-Path $dirFull "$Name-upload-cert.pem"
$readme = Join-Path $dirFull "$Name-README.txt"
foreach ($f in $keystore, $pem, $readme) {
  if (Test-Path -LiteralPath $f) { throw "refused: $f already exists. An existing key is never replaced or rotated; move the files away yourself if you really mean to start over." }
}
New-Item -ItemType Directory -Force -Path $dirFull | Out-Null

function Invoke-Keytool([string[]] $arguments) {
  & $Keytool @arguments
  if ($LASTEXITCODE -ne 0) { throw "keytool failed (exit code $LASTEXITCODE)" }
}

''
'keytool will now ask for a NEW keystore password (twice) and for the certificate name fields.'
'Use a long ASCII password and store it in your password manager right away.'
''
# PKCS12: one password for the keystore and the key. RSA 4096, 10000 days (about 27 years; Google
# Play requires validity beyond 22 October 2033 and recommends at least 25 years).
Invoke-Keytool @('-genkeypair', '-v', '-storetype', 'PKCS12', '-keystore', $keystore, '-alias', $Alias, '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000')

''
'keytool asks for the password again, to export the public certificate and read its fingerprints.'
Invoke-Keytool @('-exportcert', '-rfc', '-keystore', $keystore, '-alias', $Alias, '-file', $pem)

# Fingerprints from the public certificate file: no password needed.
$printed = (& $Keytool -printcert -file $pem 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'keytool could not read the exported certificate' }
$sha256 = ([regex]::Match($printed, 'SHA256:\s*([0-9A-F:]+)')).Groups[1].Value
$sha1 = ([regex]::Match($printed, 'SHA1:\s*([0-9A-F:]+)')).Groups[1].Value
$owner = ([regex]::Match($printed, 'Owner:\s*([^\r\n]+)')).Groups[1].Value
$valid = ([regex]::Match($printed, 'Valid from:\s*([^\r\n]+)')).Groups[1].Value
if (-not $sha256) { throw 'could not read the certificate fingerprint' }

$facts = @(
  'GizeCat Android upload key (public facts only; the password is not here and must never be)',
  "created:             $(Get-Date -Format o)",
  "keystore (SECRET):   $keystore",
  "alias:               $Alias",
  'type:                PKCS12, RSA 4096; the key password equals the keystore password',
  "certificate owner:   $owner",
  "validity:            $valid",
  "certificate SHA-256: $sha256",
  "certificate SHA-1:   $sha1",
  "public certificate:  $pem",
  '',
  'Next (docs/platforms/android-signing.md):',
  '1. Back up the .jks on two encrypted offline media in different places; the password separately.',
  '2. Configure signing: android/keystore.properties, or the four ANDROID_* environment variables.',
  '3. For CI: environment android-signing with the four secrets; optional variable',
  "   ANDROID_EXPECTED_CERT_SHA256 = $(($sha256 -replace ':', '').ToLowerInvariant())",
  '4. Play App Signing: this is the UPLOAD key. Google holds the app signing key (option A), unless',
  '   you chose to supply your own (option B).'
)
[IO.File]::WriteAllText($readme, (($facts -join "`r`n") + "`r`n"))
''
$facts
''
"Written: $readme"
