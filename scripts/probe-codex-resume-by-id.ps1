# Probe required by the Codex review (step_1_codex.md): prove that the thread_id
# captured in the thread.started event can be reused via `codex exec resume <id>`
# (not just --last, which depends on the cwd and local state).
# Run AFTER probe-codex.ps1 (extracts the thread_id from its JSONL output).
# Exit code: 0 if all checks pass, 1 otherwise.
#
# Usage:  .\scripts\probe-codex-resume-by-id.ps1

$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\review\probe-output"

$sourceJsonl = Join-Path $outDir "codex-stdout.jsonl"
if (-not (Test-Path $sourceJsonl)) {
    Write-Host "FAIL: $sourceJsonl missing. Run .\scripts\probe-codex.ps1 first"
    exit 1
}

# Extract the thread_id from the thread.started event (first line of the JSONL)
try {
    $firstEvent = Get-Content $sourceJsonl -TotalCount 1 -Encoding utf8 | ConvertFrom-Json
} catch {
    Write-Host "FAIL: first line of $sourceJsonl is not parsable as JSON: $_"
    exit 1
}
if ($firstEvent.type -ne "thread.started" -or -not $firstEvent.thread_id) {
    Write-Host "FAIL: could not extract thread_id (first event: $($firstEvent.type))"
    exit 1
}
$threadId = $firstEvent.thread_id
Write-Host "thread_id extracted: $threadId"

$prompt = @'
Session check question: what is the "verdict" field of the JSON I asked you to return in the VERY FIRST message of this session?
Respond with EXACTLY this JSON: {"resumed_by_id": true|false, "initial_verdict": "the value, or null if you do not remember it"}
'@

$lastMsgFile = Join-Path $outDir "codex-resume-by-id-last-message.txt"
$stdoutFile = Join-Path $outDir "codex-resume-by-id-stdout.jsonl"
$stderrFile = Join-Path $outDir "codex-resume-by-id-stderr.txt"

$start = Get-Date
$prompt | codex exec resume $threadId - --json --output-last-message $lastMsgFile 1> $stdoutFile 2> $stderrFile
$exitCode = $LASTEXITCODE
$duration = (Get-Date) - $start
Write-Host "Resume-by-id probe finished (exit $exitCode, $([math]::Round($duration.TotalSeconds, 1))s)"

# --- Checks (the probe fails explicitly instead of printing without concluding) ---
$failures = @()

if ($exitCode -ne 0) {
    $failures += "codex exec resume returned exit $exitCode (stderr: $stderrFile)"
}

# 1. The thread_id re-emitted in the resume JSONL must be identical
try {
    $resumeFirstEvent = Get-Content $stdoutFile -TotalCount 1 -Encoding utf8 | ConvertFrom-Json
    if ($resumeFirstEvent.thread_id -ne $threadId) {
        $failures += "re-emitted thread_id ($($resumeFirstEvent.thread_id)) differs from the resumed one ($threadId)"
    } else {
        Write-Host "OK    re-emitted thread_id identical"
    }
} catch {
    $failures += "resume JSONL not parsable: $_"
}

# 2. The final reply must be the expected JSON with resumed_by_id = true
if (Test-Path $lastMsgFile) {
    $lastMsg = Get-Content $lastMsgFile -Raw -Encoding utf8
    Write-Host ""
    Write-Host "--- Last agent message ---"
    Write-Host $lastMsg
    try {
        $parsed = $lastMsg | ConvertFrom-Json
        if ($parsed.resumed_by_id -eq $true) {
            Write-Host "OK    resumed_by_id = true (initial_verdict: $($parsed.initial_verdict))"
        } else {
            $failures += "resumed_by_id is not true: $($parsed.resumed_by_id)"
        }
    } catch {
        $failures += "last message not parsable as JSON: $_"
    }
} else {
    $failures += "--output-last-message file missing: $lastMsgFile"
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "PROBE: FAIL"
    $failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
Write-Host "PROBE: SUCCESS (resume <thread_id> contract validated)"
exit 0
