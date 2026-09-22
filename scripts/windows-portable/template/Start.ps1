param([switch]$DoctorOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$node = Join-Path $PSScriptRoot 'runtime/node.exe'
$tunnel = Join-Path $PSScriptRoot 'tunnel/tunnel-client.exe'
$state = Join-Path $PSScriptRoot 'data/tunnel'
$profileDirectory = Join-Path $state 'profile'
$pidFile = Join-Path $state 'tunnel.pid'
$healthFile = Join-Path $state 'health-url.txt'
$previousPath = $env:PATH
$previousNodeOptions = $env:NODE_OPTIONS
$secureKey = $null
$runLock = $null
$tunnelExit = 0
Push-Location -LiteralPath $PSScriptRoot
try {
  $env:NODE_OPTIONS = ''
  $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $tunnelId = [string]$config.tunnelId
  if ($tunnelId -notmatch '^tunnel_[A-Za-z0-9]+$') {
    throw 'Set tunnelId in config.json first. See README.html.'
  }
  # A stale PID file is not permission to terminate or reuse any process.
  if (Test-Path -LiteralPath $pidFile) {
    $previousPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$previousPid)) {
      if (Get-Process -Id $previousPid -ErrorAction SilentlyContinue) {
        throw 'A process still has the recorded tunnel PID. Check Status.ps1 before starting.'
      }
    }
  }
  & $node 'scripts/check.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'Local MCP check failed. Nothing started.' }
  New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
  $runLock = [IO.File]::Open((Join-Path $state 'run.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $env:PATH = (Join-Path $PSScriptRoot 'runtime') + ';' + $env:PATH
  $secureKey = Read-Host 'Runtime API key (hidden; not saved)' -AsSecureString
  $env:CONTROL_PLANE_API_KEY = (New-Object System.Net.NetworkCredential('', $secureKey)).Password
  if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) { throw 'Empty runtime API key.' }
  # Relative command + explicit working directory avoids Windows nested quoting.
  & $tunnel init --sample sample_mcp_stdio_local --profile portable --profile-dir $profileDirectory --tunnel-id $tunnelId --mcp-command 'node scripts/serve.mjs' --health-listen-addr '127.0.0.1:0' --force
  if ($LASTEXITCODE -ne 0) { throw 'Tunnel profile initialization failed.' }
  & $tunnel doctor --profile portable --profile-dir $profileDirectory --explain
  if ($LASTEXITCODE -ne 0) { throw 'Tunnel doctor failed.' }
  if (-not $DoctorOnly) {
    if (Test-Path -LiteralPath $healthFile) { Remove-Item -LiteralPath $healthFile }
    [IO.File]::WriteAllText((Join-Path $state 'started-at.txt'), [DateTime]::UtcNow.ToString('o'))
    Write-Host 'Starting tunnel. Leave this window open. Use Ctrl+C once to stop.'
    Write-Host 'Run Status.ps1 in a second PowerShell window to check readiness.'
    $ErrorActionPreference = 'Continue'
    & $tunnel run --profile portable --profile-dir $profileDirectory --pid.file $pidFile --health.listen-addr '127.0.0.1:0' --health.url-file $healthFile --log.format json
    $tunnelExit = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { Write-Warning ('Tunnel exited with code ' + $LASTEXITCODE) }
  }
}
finally {
  Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
  if ($null -ne $secureKey) { $secureKey.Dispose() }
  if ($null -ne $runLock) { $runLock.Dispose() }
  $env:PATH = $previousPath
  $env:NODE_OPTIONS = $previousNodeOptions
  Pop-Location
}
exit $tunnelExit
