param([string]$Workflow = '', [int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $Workflow) { $Workflow = Join-Path $projectRoot 'WORKFLOW.md' }
$Workflow = (Resolve-Path -LiteralPath $Workflow).Path
$entry = Join-Path $projectRoot 'dist\src\cli.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Run npm install and npm run build first.' }
$runtimeDir = Join-Path $projectRoot '.symphony'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$pidFile = Join-Path $runtimeDir 'daemon.json'
if (Test-Path -LiteralPath $pidFile) {
  $previous = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
  $existing = Get-Process -Id $previous.pid -ErrorAction SilentlyContinue
  if ($existing -and $existing.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$previous.startedTicks) { throw 'Symphony is already running.' }
}
$nodePath = (Get-Command node.exe).Source
$daemon = Start-Process -FilePath $nodePath -ArgumentList @('"' + $entry + '"', '"' + $Workflow + '"', '--port', $Port) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'stderr.log') -PassThru
Start-Sleep -Milliseconds 800
if ($daemon.HasExited) { throw ('Startup failed. See ' + (Join-Path $runtimeDir 'stderr.log')) }
@{ pid = $daemon.Id; startedTicks = $daemon.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json | Set-Content -LiteralPath $pidFile
Write-Host "Symphony PID $($daemon.Id); http://127.0.0.1:$Port"
