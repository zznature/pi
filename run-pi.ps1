$ErrorActionPreference = "Stop"
$env:PI_OFFLINE = "1"

# Run pi agent; this wrapper only controls the launch path and system prompt source.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appendSystemPath = Join-Path $scriptDir ".pi\APPEND_SYSTEM.md"
$tsxBin = Join-Path $scriptDir "node_modules\.bin\tsx.cmd"
$cliPath = Join-Path $scriptDir "packages\coding-agent\src\cli.ts"

if (-not (Test-Path -LiteralPath $appendSystemPath)) {
	throw "Missing append system prompt: $appendSystemPath"
}

if (-not (Test-Path -LiteralPath $tsxBin)) {
	throw "tsx not found at $tsxBin. Run npm install --ignore-scripts from the repo root first."
}

& $tsxBin `
	--tsconfig (Join-Path $scriptDir "tsconfig.json") `
	$cliPath `
	--no-context-files `
	--append-system-prompt $appendSystemPath `
	@args

$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
	exit $exitCode
}
