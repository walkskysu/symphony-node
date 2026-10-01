$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $projectRoot '.symphony\daemon.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No background process recorded.'; exit 0 }
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$daemon = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if ($daemon -and $daemon.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$record.startedTicks) {
  # Windows has no portable SIGTERM. Stop the entire recorded process tree.
  & taskkill.exe /PID $record.pid /T /F
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop Symphony process tree.' }
}
Remove-Item -LiteralPath $pidFile
Write-Host 'Symphony stopped. Workspaces are preserved.'
