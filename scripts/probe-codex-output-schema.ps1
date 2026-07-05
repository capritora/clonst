# Probe of `codex exec --output-schema <file>`: can the CLI ENFORCE the JSON
# shape of the final reply (instead of only asking for it in the prompt)?
# If yes, the consensus layer could rely on it (planned improvement).
# Run manually (consumes a small request on the ChatGPT subscription).
#
# Usage:  .\scripts\probe-codex-output-schema.ps1

$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\review\probe-output"
New-Item -ItemType Directory -Force $outDir | Out-Null

# The Clonst verdict schema (mirror of core/consensus.ts)
$schemaFile = Join-Path $outDir "verdict-schema.json"
@'
{
  "type": "object",
  "properties": {
    "verdict": { "type": "string", "enum": ["APPROVED", "CHANGES_NEEDED"] },
    "score": { "type": "integer", "minimum": 1, "maximum": 10 },
    "critique": { "type": "string" },
    "required_changes": { "type": "array", "items": { "type": "string" } },
    "suggestions": { "type": "array", "items": { "type": "string" } },
    "risks_identified": { "type": "array", "items": { "type": "string" } },
    "_feedback": { "type": "string" }
  },
  "required": ["verdict", "score", "critique", "required_changes", "suggestions", "risks_identified", "_feedback"],
  "additionalProperties": false
}
'@ | Set-Content -Encoding utf8 $schemaFile

# Prompt that INVITES the model to deviate from the schema: if the output stays
# compliant, the constraint is real, not merely suggested.
$prompt = @'
Review this trivial plan: "print hello to the console".
IMPORTANT: respond in FREE PROSE, with markdown headings, without any JSON.
'@

$lastMsgFile = Join-Path $outDir "codex-schema-last-message.txt"
$stdoutFile = Join-Path $outDir "codex-schema-stdout.jsonl"
$stderrFile = Join-Path $outDir "codex-schema-stderr.txt"

$start = Get-Date
$prompt | codex exec - --json --sandbox read-only --skip-git-repo-check --output-schema $schemaFile --output-last-message $lastMsgFile 1> $stdoutFile 2> $stderrFile
$exitCode = $LASTEXITCODE
$duration = (Get-Date) - $start

Write-Host "Output-schema probe finished (exit $exitCode, $([math]::Round($duration.TotalSeconds, 1))s)"
Write-Host ""
Write-Host "--- Last message (schema-compliant despite the hostile prompt?) ---"
if (Test-Path $lastMsgFile) {
    $msg = Get-Content $lastMsgFile -Raw
    Write-Host $msg
    try {
        $null = $msg | ConvertFrom-Json
        Write-Host ""
        Write-Host "PROBE VERDICT: the message is valid JSON (constraint effective)"
    } catch {
        Write-Host ""
        Write-Host "PROBE VERDICT: NOT valid JSON (constraint not effective)"
    }
} else {
    Write-Host "(file missing)"
}