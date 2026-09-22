param([switch]$Force)
$ErrorActionPreference = 'Stop'
if (-not $Force) {
  Write-Host 'Normal stop: press Ctrl+C once in the Start.ps1 window and wait up to 45 seconds.'
  Write-Host 'Only if it hangs: powershell -NoProfile -ExecutionPolicy Bypass -File .\Stop.ps1 -Force'
  exit 0
}
$state = Join-Path $PSScriptRoot 'data/tunnel'
$pidFile = Join-Path $state 'tunnel.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { throw 'No owned tunnel PID recorded.' }
$tunnelProcessId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$tunnelProcessId"
if (-not $owner) { Write-Host 'Tunnel process already exited.'; exit 0 }
$expectedExe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'tunnel/tunnel-client.exe'))
$started = [DateTime]::Parse((Get-Content -LiteralPath (Join-Path $state 'started-at.txt') -Raw)).ToUniversalTime()
if ($owner.ExecutablePath -ine $expectedExe -or $owner.CreationDate.ToUniversalTime() -lt $started.AddSeconds(-2)) {
  throw 'PID identity does not match this kit. Refusing to stop it.'
}
# Collect only this verified process tree. Never terminate by image name.
$allProcesses = @(Get-CimInstance Win32_Process)
$owned = @($owner)
for ($i = 0; $i -lt $owned.Count; $i++) {
  $parent = $owned[$i]
  $children = @($allProcesses | Where-Object {
    $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate
  })
  foreach ($child in $children) {
    if ($owned.ProcessId -notcontains $child.ProcessId) { $owned += $child }
  }
}
[array]::Reverse($owned)
foreach ($record in $owned) {
  $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $record.ProcessId)
  if ($current -and $current.CreationDate -eq $record.CreationDate -and $current.ExecutablePath -eq $record.ExecutablePath) {
    Stop-Process -Id $record.ProcessId -Force -ErrorAction Stop
  }
}
Write-Host 'Owned process tree was forcibly stopped. This is not a graceful shutdown.'
Write-Host 'Unfinished jobs will be interrupted on restart. Run Status.ps1 to verify.'
