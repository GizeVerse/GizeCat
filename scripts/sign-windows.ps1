<#
.SYNOPSIS
  OWNER TOOL. Signs GizeCat's Windows installers with a publicly trusted code-signing certificate
  from the Windows certificate store, then verifies the result. Agents never run it.

.DESCRIPTION
  For a certificate whose private key lives on a hardware token, a smart card or a cloud HSM that
  exposes the key through the Windows certificate store (for example a Certum card or SimplySign
  virtual card, a token with the issuing CA's minidriver, or a cloud key with a Windows KSP). Since
  June 2023 a new code-signing certificate cannot be exported as a .pfx, so this is the local route;
  the CI route is SignPath (.github/workflows/release.yml, docs/platforms/windows-signing.md).

  It signs and verifies signatures. It never runs an installer and it is not a test.

  Modes:
  - SignExisting (default). Copies the final unsigned installers from release\<version>\windows to
    release\<version>\windows-signed and signs the copies: SHA-256 file digest (/fd sha256), RFC 3161
    timestamp with a SHA-256 digest (/tr <TimestampUrl> /td sha256). The originals are never touched.
    When release\<version>\SHA256SUMS.txt exists, each input must match it, so exactly the
    inventoried candidate files are signed. The DesktopCat.exe, DesktopCatUia.exe and uninstaller
    inside each installer stay unsigned in this mode.
  - Rebuild. Builds the installers again from the current, clean commit; electron-builder signs every
    executable it produces (DesktopCat.exe, DesktopCatUia.exe, the uninstaller, the installers) with
    the certificate, using the SHA-256 and RFC 3161 settings in electron-builder.yml and
    forceCodeSigning, into release\<version>\windows-signed. A new build: its checksums differ from
    the unsigned candidate files and its provenance is the current commit.

  Fails closed. It stops with exit code 1, and removes the signed installers it produced in this
  run, when:
  - the certificate is missing, has no private key, is not valid yet, has expired, lacks the code
    signing usage or does not chain to a trusted root (so a self-made certificate is refused);
  - a signature or timestamp fails;
  - the digest is not SHA-256;
  - a signed installer differs from its unsigned input anywhere outside the signature (SignExisting).
  Nothing in the output folder is overwritten: the folder must be empty or absent.

  Secrets: the script never asks for, stores or prints a PIN or password. A token or cloud signing
  client asks for its PIN or one-time code in its own window. It prints only public certificate data
  (subject, issuer, thumbprint, dates).

.PARAMETER CertificateThumbprint
  SHA-1 thumbprint (40 hex characters) of the code-signing certificate in Cert:\CurrentUser\My or
  Cert:\LocalMachine\My. List candidates with:
  Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Issuer, Thumbprint, NotAfter

.PARAMETER TimestampUrl
  RFC 3161 timestamp service. Default http://timestamp.digicert.com. Prefer the service of the CA
  that issued the certificate when it publishes one (for Certum: http://time.certum.pl).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\sign-windows.ps1 -CertificateThumbprint <40-hex-thumbprint>

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\sign-windows.ps1 -CertificateThumbprint <40-hex-thumbprint> -Mode Rebuild -TimestampUrl http://time.certum.pl
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidatePattern('^[0-9A-Fa-f]{40}$')] [string] $CertificateThumbprint,
  [ValidateSet('SignExisting', 'Rebuild')] [string] $Mode = 'SignExisting',
  [string] $Version,
  [ValidatePattern('^https?://[^\s"]+$')] [string] $TimestampUrl = 'http://timestamp.digicert.com',
  [string] $InputDir,
  [string] $OutputDir,
  [string] $Signtool
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo
$thumb = $CertificateThumbprint.ToUpperInvariant()
$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$projectUrl = 'https://github.com/GizeVerse/GizeCat'

function Invoke-Native([string] $what, [scriptblock] $command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $command
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $previous
  if ($rc -ne 0) { throw "$what failed (exit code $rc)" }
}

function Find-Signtool {
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $found = Get-ChildItem -LiteralPath $kits -Directory -Filter '10.*' -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "$arch\signtool.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
  if (-not $found) { throw "signtool.exe not found under ${kits}: install the Windows SDK signing tools, or pass -Signtool" }
  return $found
}

function Get-Sha256([string] $file) { (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }

# --- Inputs and refusal checks ------------------------------------------------------------------
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$') { throw "unexpected version '$Version'" }
if (-not $InputDir) { $InputDir = Join-Path $repo "release\$Version\windows" }
if (-not $OutputDir) { $OutputDir = Join-Path $repo "release\$Version\windows-signed" }
if (-not $Signtool) { $Signtool = Find-Signtool }
if ($env:ELECTRON_BUILDER_OFFLINE -eq 'true') { throw 'ELECTRON_BUILDER_OFFLINE=true makes electron-builder skip the timestamp; unset it' }
if ((Test-Path -LiteralPath $OutputDir) -and (Get-ChildItem -LiteralPath $OutputDir -Force | Select-Object -First 1)) {
  throw "$OutputDir is not empty. Nothing is overwritten: move it away (keep it if it holds signed files you need)."
}

# --- The certificate ----------------------------------------------------------------------------
$cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumb" -ErrorAction SilentlyContinue
$machineStore = $false
if (-not $cert) {
  $cert = Get-Item -LiteralPath "Cert:\LocalMachine\My\$thumb" -ErrorAction SilentlyContinue
  $machineStore = [bool]$cert
}
if (-not $cert) { throw "no certificate with thumbprint $thumb in Cert:\CurrentUser\My or Cert:\LocalMachine\My (is the token connected, or the cloud signing client signed in?)" }
"certificate: $($cert.Subject)"
"issuer:      $($cert.Issuer)"
"thumbprint:  $($cert.Thumbprint)  valid $($cert.NotBefore.ToString('yyyy-MM-dd')) to $($cert.NotAfter.ToString('yyyy-MM-dd'))"
$now = Get-Date
if (-not $cert.HasPrivateKey) { throw 'the certificate has no associated private key on this machine (token not connected, or the store entry is not linked to it)' }
if ($cert.NotBefore -gt $now) { throw 'the certificate is not valid yet' }
if ($cert.NotAfter -le $now) { throw 'the certificate has expired' }
$ekus = @($cert.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId })
if ($ekus -notcontains $codeSigningOid) { throw 'the certificate does not carry the Code Signing usage (1.3.6.1.5.5.7.3.3)' }
$chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
[void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object System.Security.Cryptography.Oid $codeSigningOid))
if (-not $chain.Build($cert)) {
  $why = ($chain.ChainStatus | ForEach-Object { $_.StatusInformation.Trim() }) -join '; '
  throw "the certificate does not chain to a trusted root for code signing: $why"
}
"signtool:    $Signtool"
"timestamp:   $TimestampUrl"
"mode:        $Mode"

$commit = (& git rev-parse HEAD).Trim()
$created = New-Object System.Collections.Generic.List[string]

function Remove-Produced {
  foreach ($f in $created) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
  if (Test-Path -LiteralPath $OutputDir) {
    Get-ChildItem -LiteralPath $OutputDir -Filter 'Desktop-Cat-Setup-*' -File | Remove-Item -Force
    Set-Content -LiteralPath (Join-Path $OutputDir 'SIGNING-FAILED.txt') -Encoding ascii -Value @(
      "Signing failed on $(Get-Date -Format o). The signed installers of this run were removed.",
      'Nothing in this folder is a signed release file.')
  }
}

try {
  if ($Mode -eq 'SignExisting') {
    # --- Sign copies of the existing final installers ---------------------------------------------
    $inputs = @('x64', 'arm64') | ForEach-Object { Join-Path $InputDir "Desktop-Cat-Setup-$Version-$_.exe" }
    foreach ($f in $inputs) {
      if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "input installer not found: $f" }
      $state = (Get-AuthenticodeSignature -LiteralPath $f).Status
      if ("$state" -ne 'NotSigned') { throw "$f is not an unsigned installer (signature status $state)" }
    }
    $inventory = Join-Path $repo "release\$Version\SHA256SUMS.txt"
    if (Test-Path -LiteralPath $inventory) {
      $listed = @{}
      foreach ($line in Get-Content -LiteralPath $inventory) {
        if ($line -match '^([0-9a-f]{64})\s+\*?(.+)$') { $listed[(Split-Path -Leaf $Matches[2])] = $Matches[1] }
      }
      foreach ($f in $inputs) {
        $name = Split-Path -Leaf $f
        if (-not $listed.ContainsKey($name)) { throw "$name is not listed in $inventory" }
        if ((Get-Sha256 $f) -ne $listed[$name]) { throw "$name does not match its SHA-256 in ${inventory}: not the inventoried candidate file" }
      }
      "inputs match $inventory"
    }
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $pairs = @()
    foreach ($f in $inputs) {
      $target = Join-Path $OutputDir (Split-Path -Leaf $f)
      Copy-Item -LiteralPath $f -Destination $target
      $created.Add($target)
      $pairs += , @($f, $target)
      $storeArgs = if ($machineStore) { @('/sm') } else { @() }
      Invoke-Native "signtool sign $(Split-Path -Leaf $target)" {
        & $Signtool sign @storeArgs /sha1 $thumb /fd sha256 /tr $TimestampUrl /td sha256 /d 'GizeCat' /du $projectUrl $target
      }
    }
    $signed = @($pairs | ForEach-Object { $_[1] })
    & (Join-Path $PSScriptRoot 'verify-windows-signature.ps1') -Path $signed -ExpectedThumbprint $thumb -Signtool $Signtool
    if ($LASTEXITCODE -ne 0) { throw 'signature verification failed' }
    $compareArgs = @($pairs | ForEach-Object { $_[0]; $_[1] })
    Invoke-Native 'the byte comparison of signed and unsigned installers' { & node (Join-Path $PSScriptRoot 'compare-signed-pe.mjs') @compareArgs }
  } else {
    # --- Rebuild with electron-builder signing every executable -----------------------------------
    foreach ($name in 'CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD', 'CSC_NAME') {
      if ([Environment]::GetEnvironmentVariable($name)) { throw "unset $name first: Rebuild signs only with the store certificate given by -CertificateThumbprint" }
    }
    $dirty = (& git status --porcelain)
    if ($dirty) { throw 'the working tree has uncommitted changes: commit them first, so the signed build has an exact commit as provenance' }
    $env:SIGNTOOL_PATH = $Signtool
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputDir) | Out-Null
    $outRel = Resolve-Path -LiteralPath (Split-Path -Parent $OutputDir) -Relative
    $outArg = (Join-Path $outRel (Split-Path -Leaf $OutputDir)) -replace '\\', '/'
    if ($outArg -match '\s') { throw "the output path must not contain spaces: $outArg" }
    Invoke-Native 'staging the ARM64 koffi binary' { & node scripts/stage-koffi-arch.mjs --arch arm64 }
    Invoke-Native 'the build' { & node scripts/with-lock.mjs sign-win-build -- node scripts/build.mjs }
    Invoke-Native 'packaging and signing' {
      & node scripts/with-lock.mjs sign-win-package -- npx electron-builder --win nsis --x64 --arm64 --publish never `
        "-c.directories.output=$outArg" -c.forceCodeSigning=true `
        "-c.win.signtoolOptions.certificateSha1=$thumb" "-c.win.signtoolOptions.rfc3161TimeStampServer=$TimestampUrl"
    }
    foreach ($a in @(@('x64', 'win-unpacked'), @('arm64', 'win-arm64-unpacked'))) {
      Invoke-Native "static payload check $($a[0])" { & node scripts/check-win-payload.mjs --arch $a[0] --dir (Join-Path $OutputDir $a[1]) }
    }
    $signed = @('x64', 'arm64') | ForEach-Object { Join-Path $OutputDir "Desktop-Cat-Setup-$Version-$_.exe" }
    foreach ($f in $signed) { if (Test-Path -LiteralPath $f) { $created.Add($f) } }
    $inner = @()
    foreach ($d in 'win-unpacked', 'win-arm64-unpacked') {
      $inner += Join-Path $OutputDir "$d\DesktopCat.exe"
      $uia = Join-Path $OutputDir "$d\resources\native\DesktopCatUia.exe"
      if (Test-Path -LiteralPath $uia) { $inner += $uia } else { "note: $d has no DesktopCatUia.exe (no csc.exe on this machine)" }
    }
    & (Join-Path $PSScriptRoot 'verify-windows-signature.ps1') -Path ($signed + $inner) -ExpectedThumbprint $thumb -Signtool $Signtool
    if ($LASTEXITCODE -ne 0) { throw 'signature verification failed' }
  }

  # --- Checksums and provenance ---------------------------------------------------------------------
  $sums = ($signed | Sort-Object | ForEach-Object { '{0}  {1}' -f (Get-Sha256 $_), (Split-Path -Leaf $_) }) -join "`n"
  [IO.File]::WriteAllText((Join-Path $OutputDir 'SHA256SUMS-windows-signed.txt'), $sums + "`n")
  $provenance = @(
    "GizeCat $Version Windows installers, Authenticode signed",
    "mode: $Mode",
    "signed: $(Get-Date -Format o)",
    "repository commit at signing time: $commit",
    "certificate subject: $($cert.Subject)",
    "certificate issuer: $($cert.Issuer)",
    "certificate thumbprint (SHA-1): $($cert.Thumbprint)",
    "certificate validity: $($cert.NotBefore.ToString('yyyy-MM-dd')) to $($cert.NotAfter.ToString('yyyy-MM-dd'))",
    'file digest: SHA-256; timestamp: RFC 3161 with SHA-256',
    "timestamp service: $TimestampUrl"
  )
  if ($Mode -eq 'SignExisting') {
    $provenance += 'inputs (unsigned) -> outputs (signed):'
    foreach ($p in $pairs) { $provenance += "  $(Get-Sha256 $p[0])  ->  $(Get-Sha256 $p[1])  $(Split-Path -Leaf $p[1])" }
    $provenance += 'Inner DesktopCat.exe, DesktopCatUia.exe and uninstaller: unsigned (SignExisting signs only the installers).'
  } else {
    $provenance += "built from commit $commit with a clean working tree; every executable signed by electron-builder"
  }
  [IO.File]::WriteAllText((Join-Path $OutputDir 'signing-provenance-windows.txt'), (($provenance -join "`n") + "`n"))
  ''
  $sums
  "signed installers, checksums and provenance: $OutputDir"
  'Next: keep the unsigned candidate files, publish only after reviewing this folder (docs/platforms/release-owner-actions.md).'
  exit 0
} catch {
  [Console]::Error.WriteLine("FAILED: $($_.Exception.Message)")
  Remove-Produced
  exit 1
}
