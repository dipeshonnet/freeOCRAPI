param([switch]$Verify)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$taskPnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($taskPnpmCommand) { $taskPnpm = $taskPnpmCommand.Source } else {
  $taskPnpm = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
  if (-not (Test-Path -LiteralPath $taskPnpm)) { throw 'Install Node.js 24 and pnpm, then rerun this script.' }
}
& $taskPnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Verify) {
  foreach ($taskCheck in @('typecheck','test','build')) { & $taskPnpm run $taskCheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
} else { & $taskPnpm run dev }
