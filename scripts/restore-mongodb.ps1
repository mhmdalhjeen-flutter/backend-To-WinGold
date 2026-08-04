# Offers Tech — MongoDB restore (mongorestore)
# Usage: .\scripts\restore-mongodb.ps1 -BackupDir ".\backups\20260704-183000" [-TargetDb "test_restore"] [-Scratch]
# Requires: MONGO_URI in backend/.env; MongoDB Database Tools on PATH.

param(
    [Parameter(Mandatory = $true)]
    [string]$BackupDir,
    [string]$TargetDb = "",
    [switch]$Scratch
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

$resolvedBackup = Resolve-Path $BackupDir
$sourceDbDir = Get-ChildItem $resolvedBackup -Directory | Select-Object -First 1
if (-not $sourceDbDir) {
    Write-Error "No database folder found inside $BackupDir (expected <backup>/<db_name>/*.bson.gz)"
}
$sourceDb = $sourceDbDir.Name

$mongorestore = Get-Command mongorestore -ErrorAction SilentlyContinue
if (-not $mongorestore) {
    $fallback = "C:\Program Files\MongoDB\Tools\100\bin\mongorestore.exe"
    if (Test-Path $fallback) { $mongorestore = $fallback } else { Write-Error "mongorestore not found. Install MongoDB Database Tools." }
}

if ($Scratch -or [string]::IsNullOrWhiteSpace($TargetDb)) {
    $TargetDb = "${sourceDb}_restore_$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Write-Host "Scratch restore target: $TargetDb"
}

Write-Host "Restoring $sourceDb -> $TargetDb from $resolvedBackup ..."
if ($mongorestore -is [System.Management.Automation.ApplicationInfo] -or $mongorestore -is [System.Management.Automation.CommandInfo]) {
    & mongorestore --uri $env:MONGO_URI --gzip --drop `
        --nsFrom "${sourceDb}.*" --nsTo "${TargetDb}.*" $resolvedBackup
} else {
    & $mongorestore --uri $env:MONGO_URI --gzip --drop `
        --nsFrom "${sourceDb}.*" --nsTo "${TargetDb}.*" $resolvedBackup
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Restore complete. Target database: $TargetDb"
if ($Scratch) {
    Write-Host "Drop when done: mongosh `"$env:MONGO_URI`" --eval `"db.getSiblingDB('$TargetDb').dropDatabase()`""
}
