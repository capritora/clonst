# Probe of session resume: `codex exec resume --last`.
# Run AFTER probe-codex.ps1 (resumes the last session created).
# Validates that Codex keeps memory between two non-interactive invocations,
# which is the core mechanism of the Clonst ping-pong.
#
# Usage:  .\scripts\probe-codex-resume.ps1

$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\review\probe-output"
New-Item -ItemType Directory -Force $outDir | Out-Null

$prompt = @'
Which JSON did I ask you to return in my previous message?
Respond with EXACTLY this JSON: {"remembered": true|false, "previous_verdict": "the verdict value I asked you for, or null"}
'@

$lastMsgFile = Join-Path $outDir "codex-resume-last-message.txt"
$stdoutFile = Join-Path $outDir "codex-resume-stdout.jsonl"
$stderrFile = Join-Path $outDir "codex-resume-stderr.txt"

$start = Get-Date
# NB: unlike `codex exec`, the `resume` subcommand does not accept --sandbox
# (the sandbox is inherited from the resumed session).
$prompt | codex exec resume --last - --json --output-last-message $lastMsgFile 1> $stdoutFile 2> $stderrFile
$exitCode = $LASTEXITCODE
$duration = (Get-Date) - $start

Write-Host "Resume probe finished (exit $exitCode, $([math]::Round($duration.TotalSeconds, 1))s)"
Write-Host ""
Write-Host "--- Last agent message ---"
if (Test-Path $lastMsgFile) { Get-Content $lastMsgFile } else { Write-Host "(file missing)" }
