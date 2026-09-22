param(
  [Parameter(Mandatory=$true)][string]$NodeArchive,
  [Parameter(Mandatory=$true)][string]$TunnelArchive,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Output directory already exists; choose a new directory.' }
$nodeZip = (Resolve-Path -LiteralPath $NodeArchive).Path
$tunnelZip = (Resolve-Path -LiteralPath $TunnelArchive).Path
$nodeHash = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
$tunnelHash = (Get-FileHash -LiteralPath $tunnelZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nodeHash -ne 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62') { throw 'Expected the verified Node 24.15.0 Windows x64 ZIP.' }
if ($tunnelHash -ne '784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5') { throw 'Expected the tested tunnel-client 0.0.14 Windows amd64 full ZIP.' }
$stage = Join-Path $repo ('.tmp/portable-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
Expand-Archive -LiteralPath $nodeZip -DestinationPath (Join-Path $stage 'node')
Push-Location -LiteralPath $repo
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
  $sourceCommit = & git -c ("safe.directory=" + $repo.Replace('\','/')) rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Cannot determine source commit.' }
  New-Item -ItemType Directory -Path $output | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'template') -Destination (Join-Path $stage 'template') -Recurse
  Get-ChildItem -LiteralPath (Join-Path $stage 'template') | Copy-Item -Destination $output -Recurse
  $server = Join-Path $output 'server'
  $runtime = Join-Path $output 'runtime'
  New-Item -ItemType Directory -Path $server,$runtime | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination $server -Recurse
  foreach ($name in @('package.json','package-lock.json','LICENSE','README.md')) {
    Copy-Item -LiteralPath (Join-Path $repo $name) -Destination $server
  }
  foreach ($name in @('node.exe','LICENSE','README.md')) {
    Copy-Item -LiteralPath (Join-Path $stage ('node/node-v24.15.0-win-x64/' + $name)) -Destination $runtime
  }
  Expand-Archive -LiteralPath $tunnelZip -DestinationPath (Join-Path $output 'tunnel')
  & npm.cmd ci --omit=dev --ignore-scripts --prefix $server
  if ($LASTEXITCODE -ne 0) { throw 'Production dependencies failed to install.' }
  $manifest = [ordered]@{
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceCommit = $sourceCommit.Trim()
    platform = 'windows-x64'
    nodeVersion = '24.15.0'
    nodeArchiveSha256 = $nodeHash
    nodeSource = 'https://nodejs.org/dist/v24.15.0/'
    tunnelVersion = '0.0.14'
    tunnelArchiveSha256 = $tunnelHash
    tunnelSource = 'https://github.com/openai/tunnel-client/releases'
    note = 'Runtime source commit plus portable templates; SHA256SUMS.json records actual delivered bytes. No credentials or production files included.'
  }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $output 'BUILD.json'), ($manifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine, $utf8)
  $markdown = [IO.File]::ReadAllText((Join-Path $output 'README.md'))
  # Offline readable copy, no CDN or JavaScript dependency.
  $encoded = [System.Net.WebUtility]::HtmlEncode($markdown)
  $linked = [regex]::Replace($encoded, 'https://[^\s<>]+', '<a href="$0">$0</a>')
  $html = '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Schwarzbeck MCP - Windows</title><style>body{max-width:1000px;margin:40px auto;padding:0 24px;background:#f7f8fa;color:#17212b}pre{white-space:pre-wrap;font:16px/1.65 system-ui,Segoe UI,sans-serif}</style><body><pre>' + $linked + '</pre></body></html>'
  [IO.File]::WriteAllText((Join-Path $output 'README.html'), $html, $utf8)
  & (Join-Path $runtime 'node.exe') (Join-Path $output 'scripts/check.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Assembled kit failed its local MCP check.' }
  $hashes = @()
  foreach ($file in Get-ChildItem -LiteralPath $output -Recurse -File | Sort-Object FullName) {
    $relativeName = $file.FullName.Substring($output.TrimEnd('\').Length + 1).Replace('\','/')
    if ($relativeName.StartsWith('data/')) { continue }
    $hashes += [ordered]@{ path=$relativeName; size=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  [IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.json'), ($hashes | ConvertTo-Json -Depth 4) + [Environment]::NewLine, $utf8)
  Write-Host ('PORTABLE_BUILD_PASS: ' + $output)
}
finally { Pop-Location }
