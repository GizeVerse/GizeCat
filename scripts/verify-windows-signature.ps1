<#
.SYNOPSIS
  Verifies the Authenticode signatures of Windows files. Reads the files; runs none of them.

.DESCRIPTION
  Cryptographic signature verification, not a test: nothing is executed. For every file:
  - Get-AuthenticodeSignature reports Valid, an embedded Authenticode signature (not a catalog
    signature) and a timestamp countersignature;
  - signtool verify /pa /all /tw /v (Windows SDK) exits 0 with no warnings, every signature in the
    file uses a SHA-256 file digest, and every signature is timestamped;
  - optionally the signing certificate matches -ExpectedThumbprint and/or -ExpectedSubject.
  Exit code 0 only when every file passes. Prints certificate subjects, issuers, thumbprints and
  validity dates, which are public parts of a signed file; it never handles a private key or a
  password.

  Used by .github/workflows/release.yml (SignPath route) and scripts/sign-windows.ps1 (local route).
  Works in Windows PowerShell 5.1 and PowerShell 7.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\verify-windows-signature.ps1 release\1.4.0\windows-signed\Desktop-Cat-Setup-1.4.0-x64.exe release\1.4.0\windows-signed\Desktop-Cat-Setup-1.4.0-arm64.exe
#>
[CmdletBinding()]
param(
  # Several files: list them after the script (powershell -File passes each as its own argument),
  # or pass an array when calling the script from PowerShell (& .\verify-windows-signature.ps1 -Path $a, $b).
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)] [string[]] $Path,
  [string] $ExpectedThumbprint,
  [string] $ExpectedSubject,
  [string] $Signtool
)
$ErrorActionPreference = 'Stop'

function Find-Signtool {
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $found = Get-ChildItem -LiteralPath $kits -Directory -Filter '10.*' -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "$arch\signtool.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
  if (-not $found) { throw "signtool.exe not found under $kits (install the Windows SDK signing tools, or pass -Signtool)" }
  return $found
}

if (-not $Signtool) { $Signtool = Find-Signtool }
if (-not (Test-Path -LiteralPath $Signtool)) { throw "signtool not found: $Signtool" }
"signtool: $Signtool"

$failedFiles = 0
foreach ($item in $Path) {
  $problems = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $item -PathType Leaf)) {
    "FAIL ${item}: file not found"
    $failedFiles++
    continue
  }
  $file = Get-Item -LiteralPath $item
  $sig = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($sig.Status -ne 'Valid') { $problems.Add("Get-AuthenticodeSignature status $($sig.Status): $($sig.StatusMessage)") }
  if ("$($sig.SignatureType)" -ne 'Authenticode') { $problems.Add("signature type '$($sig.SignatureType)': an embedded Authenticode signature is required, not a catalog signature") }
  if ($null -eq $sig.TimeStamperCertificate) { $problems.Add('no timestamp countersignature: the signature would stop validating when the certificate expires') }
  $cert = $sig.SignerCertificate
  if ($null -ne $cert) {
    if ($ExpectedThumbprint -and $cert.Thumbprint -ne $ExpectedThumbprint.ToUpperInvariant()) {
      $problems.Add("signed with certificate $($cert.Thumbprint), expected $($ExpectedThumbprint.ToUpperInvariant())")
    }
    if ($ExpectedSubject -and -not $cert.Subject.Contains($ExpectedSubject)) {
      $problems.Add("signer subject '$($cert.Subject)' does not contain '$ExpectedSubject'")
    }
  } else {
    $problems.Add('no signer certificate')
  }

  # Windows PowerShell 5.1 turns redirected native stderr into errors; collect signtool output
  # without letting that stop the script, then judge it by exit code and content.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = (& $Signtool verify /pa /all /tw /v $file.FullName 2>&1 | Out-String)
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $previous
  if ($rc -ne 0) { $problems.Add("signtool verify exit code $rc (1 = invalid, 2 = warning such as a missing timestamp)") }
  $digests = @([regex]::Matches($out, 'Hash of file \(([A-Za-z0-9]+)\)') | ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() })
  $stamped = ([regex]::Matches($out, 'The signature is timestamped:')).Count
  if ($digests.Count -eq 0) { $problems.Add('signtool reported no signature digest') }
  $weak = @($digests | Where-Object { $_ -ne 'sha256' })
  if ($weak.Count -gt 0) { $problems.Add("signature digest(s) other than SHA-256: $($weak -join ', ')") }
  if ($digests.Count -gt 0 -and $stamped -lt $digests.Count) { $problems.Add("only $stamped of $($digests.Count) signature(s) are timestamped") }
  if ($out -notmatch 'Number of warnings: 0') { $problems.Add('signtool reported warnings') }

  $stampTime = ([regex]::Match($out, 'The signature is timestamped: ([^\r\n]+)')).Groups[1].Value
  $tsaSubject = if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { '-' }
  if ($problems.Count -eq 0) {
    "OK   $($file.Name)"
  } else {
    "FAIL $($file.Name)"
    $failedFiles++
  }
  if ($null -ne $cert) {
    "     signer:     $($cert.Subject)"
    "     issuer:     $($cert.Issuer)"
    "     thumbprint: $($cert.Thumbprint)  valid $($cert.NotBefore.ToString('yyyy-MM-dd')) to $($cert.NotAfter.ToString('yyyy-MM-dd'))"
  }
  "     digests:    $($digests -join ', ')"
  "     timestamp:  $stampTime by $tsaSubject"
  foreach ($p in $problems) { "     problem:    $p" }
}

if ($failedFiles -gt 0) {
  [Console]::Error.WriteLine("$failedFiles of $($Path.Count) file(s) failed signature verification")
  exit 1
}
"all $($Path.Count) file(s) carry a valid, SHA-256, timestamped Authenticode signature"
exit 0
