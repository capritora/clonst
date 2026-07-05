# Probe of the CLI contract for Clonst config overrides (codex_model /
# codex_reasoning_effort): verify that codex ROOT `-c` flags are accepted
# by `exec` AND by `exec resume`, in the exact order Clonst builds them.
# CONSUMES QUOTA (2 small calls at "low" effort): manual execution only.
# Exit code: 0 if both invocations pass, 1 otherwise.
#
# Usage:  .\scripts\probe-codex-config-override.ps1

$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\review\probe-output"
New-Item -ItemType Directory -Force $outDir | Out-Null

$failures = @()

# BOTH real Clonst keys are tested: model AND model_reasoning_effort.
# The model name is not hardcoded (it would go stale): we read the one already
# configured in ~/.codex/config.toml and pass it back explicitly as an override.
$codexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
$model = $null
if (Test-Path $codexConfig) {
    $modelLine = Get-Content $codexConfig -Encoding utf8 | Where-Object { $_ -match '^\s*model\s*=\s*"([^"]+)"' } | Select-Object -First 1
    if ($modelLine -match '^\s*model\s*=\s*"([^"]+)"') { $model = $Matches[1] }
}
if (-not $model) {
    Write-Host "FAIL: could not read 'model' in $codexConfig (the -c model=... test needs a valid name)"
    exit 1
}
Write-Host "model tested as explicit override: $model"

# --- 1. New session with root overrides (exact mirror of buildArgs) ---
$prompt1 = 'Respond with EXACTLY this JSON, nothing else: {"probe": "override-exec"}'
$stdout1 = Join-Path $outDir "codex-override-exec-stdout.jsonl"
$stderr1 = Join-Path $outDir "codex-override-exec-stderr.txt"
$last1 = Join-Path $outDir "codex-override-exec-last-message.txt"

$start = Get-Date
$prompt1 | codex -c model=$model -c model_reasoning_effort=low exec - --sandbox read-only --json --skip-git-repo-check --output-last-message $last1 1> $stdout1 2> $stderr1
$exit1 = $LASTEXITCODE
Write-Host "exec with root -c: exit $exit1 ($([math]::Round(((Get-Date) - $start).TotalSeconds, 1))s)"
if ($exit1 -ne 0) {
    $failures += "codex -c ... exec returned exit $exit1 (stderr: $stderr1)"
}

# Extract the thread_id for the resume
$threadId = $null
try {
    $firstEvent = Get-Content $stdout1 -TotalCount 1 -Encoding utf8 | ConvertFrom-Json
    if ($firstEvent.type -eq "thread.started" -and $firstEvent.thread_id) {
        $threadId = $firstEvent.thread_id
        Write-Host "OK    thread_id emitted: $threadId"
    } else {
        $failures += "no thread.started on the first line (received: $($firstEvent.type))"
    }
} catch {
    $failures += "exec JSONL not parsable: $_"
}

# --- 2. Resume with the SAME root overrides (the actually uncertain point) ---
if ($threadId) {
    $prompt2 = 'Respond with EXACTLY this JSON, nothing else: {"probe": "override-resume"}'
    $stdout2 = Join-Path $outDir "codex-override-resume-stdout.jsonl"
    $stderr2 = Join-Path $outDir "codex-override-resume-stderr.txt"
    $last2 = Join-Path $outDir "codex-override-resume-last-message.txt"

    $start = Get-Date
    $prompt2 | codex -c model=$model -c model_reasoning_effort=low exec resume $threadId - --json --skip-git-repo-check --output-last-message $last2 1> $stdout2 2> $stderr2
    $exit2 = $LASTEXITCODE
    Write-Host "exec resume with root -c: exit $exit2 ($([math]::Round(((Get-Date) - $start).TotalSeconds, 1))s)"
    if ($exit2 -ne 0) {
        $failures += "codex -c ... exec resume returned exit $exit2 (stderr: $stderr2)"
    } elseif (-not (Test-Path $last2)) {
        $failures += "resume: --output-last-message file missing"
    } else {
        Write-Host "OK    resume with override accepted, reply: $(Get-Content $last2 -Raw -Encoding utf8)"
    }
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "PROBE: FAIL (do NOT use codex_model/codex_reasoning_effort in ~/.clonst/config.json until fixed)"
    $failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
Write-Host "PROBE: SUCCESS (root -c overrides are accepted by exec and resume)"
exit 0
