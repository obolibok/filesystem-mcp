$ErrorActionPreference = 'Stop'
$state = Join-Path $PSScriptRoot 'data/tunnel'
$pidFile = Join-Path $state 'tunnel.pid'
$healthFile = Join-Path $state 'health-url.txt'
if (Test-Path -LiteralPath $pidFile) {
  $tunnelProcessId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
  $process = Get-Process -Id $tunnelProcessId -ErrorAction SilentlyContinue
  if ($process) { Write-Host ('Recorded PID is running: ' + $tunnelProcessId) }
  else { Write-Host 'Recorded PID has exited.' }
}
if (-not (Test-Path -LiteralPath $healthFile)) {
  Write-Host 'No health URL yet. Start.ps1 must be running.'
  exit 1
}
$baseUrl = (Get-Content -LiteralPath $healthFile -Raw).Trim().TrimEnd('/')
$uri = [Uri]$baseUrl
if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1') {
  throw 'Refusing a non-loopback health URL.'
}
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + '/readyz') -TimeoutSec 5
  Write-Host ('Readiness HTTP ' + $response.StatusCode + ': ' + $response.Content)
  Write-Host ('Local admin UI: ' + $baseUrl + '/ui')
}
catch {
  Write-Host 'NOT READY / STOPPED. Inspect the Start.ps1 window.'
  exit 1
}
