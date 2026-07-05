# Probe of the real `codex exec` contract before writing the provider.
# Run manually (consumes a small request on the ChatGPT subscription).
#
# Usage:  .\scripts\probe-codex.ps1
#
# Produces in review/probe-output/:
#   codex-stdout.jsonl   : JSONL event stream (--json)
#   codex-stderr.txt     : raw stderr output
#   codex-last-message.txt : last agent message (--output-last-message)
#   codex-meta.txt       : exit code, duration, version

$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\review\probe-output"
New-Item -ItemType Directory -Force $outDir | Out-Null

$prompt = @'
Respond with EXACTLY this JSON and nothing else:
{"verdict": "APPROVED", "score": 9, "critique": "Test probe", "required_changes": [], "suggestions": [], "risks_identified": []}
'@

$lastMsgFile = Join-Path $outDir "codex-last-message.txt"
$stdoutFile = Join-Path $outDir "codex-stdout.jsonl"
$stderrFile = Join-Path $outDir "codex-stderr.txt"
$metaFile = Join-Path $outDir "codex-meta.txt"

$start = Get-Date
# The prompt goes through stdin (never as an argument: quoting + command line length limit)
$prompt | codex exec - --json --sandbox read-only --output-last-message $lastMsgFile 1> $stdoutFile 2> $stderrFile
$exitCode = $LASTEXITCODE
$duration = (Get-Date) - $start

@"
exit_code: $exitCode
duration_seconds: $([math]::Round($duration.TotalSeconds, 1))
codex_version: $(codex --version)
date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
"@ | Set-Content -Encoding utf8 $metaFile

Write-Host "Probe finished (exit $exitCode, $([math]::Round($duration.TotalSeconds, 1))s)"
Write-Host "Results in: $outDir"
Write-Host ""
Write-Host "--- Last agent message ---"
if (Test-Path $lastMsgFile) { Get-Content $lastMsgFile } else { Write-Host "(file missing)" }
