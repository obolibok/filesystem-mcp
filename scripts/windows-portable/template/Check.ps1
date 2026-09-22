$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
  $env:NODE_OPTIONS = ''
  & (Join-Path $PSScriptRoot 'runtime/node.exe') 'scripts/check.mjs'
  if ($LASTEXITCODE -ne 0) { throw 'Local MCP check failed.' }
}
finally { Pop-Location }
