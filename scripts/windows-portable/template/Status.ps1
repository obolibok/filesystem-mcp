$ErrorActionPreference = 'Stop'
try {
  $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch { throw 'Cannot read config.json: expected valid JSON.' }
if ($config.transport -eq 'http') {
  $http = $config.localHttp
  $httpHost = if ($null -ne $http -and $null -ne $http.host) { $http.host } else { '127.0.0.1' }
  $port = if ($null -ne $http -and $null -ne $http.port) { $http.port } else { 8766 }
  $ip = $null
  if ($httpHost -isnot [string] -or ($httpHost -cne 'localhost' -and -not [Net.IPAddress]::TryParse($httpHost, [ref]$ip))) {
    throw 'Invalid localHttp.host.'
  }
  if (($port -isnot [int] -and $port -isnot [long] -and $port -isnot [double]) -or $port -lt 1 -or $port -gt 65535 -or [Math]::Truncate([double]$port) -ne $port) { throw 'Invalid localHttp.port.' }
  $urlHost = if ($httpHost.Contains(':')) { '[' + $httpHost + ']' } else { $httpHost }
  $baseUrl = 'http://' + $urlHost + ':' + $port
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + '/healthz') -MaximumRedirection 0 -TimeoutSec 5
    if (($response.Content | ConvertFrom-Json).status -ne 'ok') { throw 'Unexpected health response.' }
    Write-Host ('HTTP MCP available: ' + $baseUrl + '/mcp')
    Write-Host 'Availability only. Check bearer authentication and MCP tools from your client.'
    exit 0
  }
  catch { Write-Host 'HTTP MCP NOT AVAILABLE. Inspect the Start.ps1 window.'; exit 1 }
}
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
