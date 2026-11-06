# Host side of the Linux container verification (ADR 0004 §12). Runs one throwaway container
# (--rm, unique name) from the local node:24-bookworm-slim image; never pulls, prunes or touches
# other containers or images. Inputs: a git archive of the commit under test plus the scripts in
# this folder. Results: $Out\summary.tsv and logs.
param(
  [Parameter(Mandatory = $true)][string]$Tar,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Script = 'verify-in-container.sh'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$in = Join-Path $Out 'in'
New-Item -ItemType Directory -Force $in | Out-Null
Copy-Item $Tar (Join-Path $in 'src.tar') -Force
Copy-Item (Join-Path $here $Script) $in -Force
Copy-Item (Join-Path $here 'x11check.py') $in -Force
$name = 'gizecat-linux-verify-' + (Get-Date -Format 'yyyyMMddHHmmss')
Set-Content -Path (Join-Path $Out 'container-name.txt') -Value $name -Encoding ascii
$started = Get-Date
# Windows PowerShell 5.1 turns a native command's stderr into an ErrorRecord; with Stop that ended run 1's
# launcher early (the attached container still finished). Errors here are data, not a reason to stop.
$ErrorActionPreference = 'Continue'
# SYS_ADMIN + unconfined seccomp let Chromium's setuid sandbox create its namespaces inside this own,
# throwaway container (run 1 had to use --no-sandbox without them).
docker run --rm --name $name --pull never --cpus 4 --memory 6g --cap-add SYS_ADMIN --security-opt seccomp=unconfined -v "${in}:/in:ro" -v "${Out}:/out" node:24-bookworm-slim bash /in/$Script *> (Join-Path $Out 'docker.log')
$code = $LASTEXITCODE
$secs = [int]((Get-Date) - $started).TotalSeconds
Set-Content -Path (Join-Path $Out 'docker-exit.txt') -Value "exit=$code seconds=$secs" -Encoding ascii
