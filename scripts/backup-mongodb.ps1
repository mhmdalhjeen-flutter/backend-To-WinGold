# Offers Tech — MongoDB backup (mongodump)
# Usage: .\scripts\backup-mongodb.ps1 [-OutDir ".\backups"]
# Requires: MONGO_URI in backend/.env or environment; MongoDB Database Tools on PATH.

param(
    [string]$OutDir = (Join-Path $PSScriptRoot ".." "backups")
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not $env:MONGO_URI) {
    $envFile = Join-Path (Get-Location) ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^\s*MONGO_URI=(.+)$') { $env:MONGO_URI = $matches[1].Trim() }
        }
    }
}

if (-not $env:MONGO_URI) {
    Write-Error "MONGO_URI is not set. Add it to backend/.env or export MONGO_URI."
}

$mongodump = Get-Command mongodump -ErrorAction SilentlyContinue
if (-not $mongodump) {
    $fallback = "C:\Program Files\MongoDB\Tools\100\bin\mongodump.exe"
    if (Test-Path $fallback) { $mongodump = $fallback } else { Write-Error "mongodump not found. Install MongoDB Database Tools." }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path (Resolve-Path $OutDir) $timestamp
New-Item -ItemType Directory -Path $target -Force | Out-Null

Write-Host "Backing up to $target ..."
if ($mongodump -is [System.Management.Automation.ApplicationInfo] -or $mongodump -is [System.Management.Automation.CommandInfo]) {
    & mongodump --uri $env:MONGO_URI --gzip --out $target
} else {
    & $mongodump --uri $env:MONGO_URI --gzip --out $target
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Backup complete: $target"
Get-ChildItem -Recurse $target -Filter "*.bson.gz" | Measure-Object | ForEach-Object {
    Write-Host "Collection files: $($_.Count)"
}
