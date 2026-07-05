# Clonst

**Adversarial code review for Claude Code, powered by Codex.** Clonst is an MCP
server that lets Claude (in Claude Code) get its plans and code critiqued by
Codex (OpenAI), in a ping-pong loop until both sides reach consensus. Both LLMs
keep their own memory: Claude through the conversation, Codex through a
persistent CLI session resumed on every round.

No API keys: Codex is driven through its official CLI (`codex exec`), which
uses your existing ChatGPT subscription.

> Independent project. Not affiliated with OpenAI ("Codex", "ChatGPT") or
> Anthropic ("Claude").

## How it works

```
You ── conversation ── Claude (reviser, keeps the conversation context)
                          │
                          │  clonst_review (MCP, one call = one critique)
                          ▼
                       Clonst ── spawn ── codex exec [resume <thread_id>]
                                             (reviewer, keeps its session)
```

The loop lives on the caller's side: Claude submits, Codex critiques, Claude
revises in the conversation (in front of you), resubmits with the `thread_id`,
until `consensus: true`. The server is stateless between calls: the `thread_id`
travels through the caller, Codex sessions persist on disk on the CLI side.

Once installed, there is nothing to remember: the tool description tells Claude
to call it by default for any development that touches logic or behavior, and
to skip it for pure presentation or documentation. At consensus, Claude ends
with a brief report: reviewer used, rounds, total duration, tokens consumed,
and what the review concretely caught.

## Requirements

- Node.js >= 22
- The Codex CLI, installed and logged in:
  ```
  npm install -g @openai/codex
  codex login        # uses your ChatGPT subscription
  ```

## Install

```
git clone https://github.com/capritora/clonst.git && cd clonst
npm install
npm run build
```

Register it in Claude Code, either:

- **For all your projects** (recommended):
  ```
  claude mcp add clonst --scope user -- node /absolute/path/to/clonst/dist/index.js
  ```
- **For one project**: copy `.mcp.json.example` to `.mcp.json` at the project
  root and set the path.

`dist/` is gitignored: run `npm run build` again after any pull or change to `src/`.

## Tools

### clonst_ping
Server health + codex CLI availability, version, login status, loaded config.
Consumes no quota.

### clonst_review
One structured critique per call. Main parameters:

| Parameter | Role |
|---|---|
| `content` | The plan/code to review, complete (later rounds: the full revised version, never a diff) |
| `context` | Round 1: goal, constraints, decisions already made |
| `project_path` | ABSOLUTE project path: Codex runs there and reads the real files (read-only sandbox) |
| `thread_id` | Later rounds: the identifier returned by the previous call (resumes the Codex session) |
| `round` | Round number (default: 1 without thread_id, 2 with) |
| `max_rounds` | Hard round limit for THIS ping-pong (optional, see below) |
| `language` | BCP-47 code for the reviewer's free-text output (e.g. "fr", "pt-BR"); the tool description instructs the calling LLM to pass your conversation language. Resolved server-side to a language name - the raw value never reaches the prompt |
| `changes_made` / `changes_rejected` | Later rounds: what was changed / rejected with justification |
| `review_focus` | Round 1: bugs, architecture, performance, security, all (default) |

Result: `verdict` (APPROVED/CHANGES_NEEDED), `consensus` (true only on a proven
APPROVED: clean JSON, zero required_changes, no fallback), `critique`,
`required_changes`, `suggestions`, `risks_identified`, `reviewer_feedback`,
`thread_id` (pass it back), `next_action` (loop instruction for the calling
LLM, also available as typed fields), `duration_seconds` / `usage` (the round),
`total_duration_seconds` / `total_usage` (whole ping-pong totals),
`reviewer_model` / `reviewer_reasoning_effort` (best-effort resolution by
Clonst: the override if set, else the codex config's root keys, else null - not
instrumented proof of the model the CLI actually used), `session_log`.

### Round limit: unlimited by default

- **Say nothing**: no limit, the ping-pong continues until consensus. Guard
  rail: at multiples of `suggested_max_rounds` (config, default 5, so rounds 5,
  10, 15...) without consensus, the calling LLM checks in with you before
  continuing; between multiples the loop resumes normally.
- **With a limit**: ask in natural language ("review this, 3 rounds max") - the
  calling LLM passes `max_rounds: 3` on every call. The reviewer is told about
  the counter (exhaustive from round 1, maximum effort on the final round, never
  approving just to close) and, at the limit without consensus, the disagreement
  goes to you for arbitration instead of another round.

## Typical usage

In a Claude Code conversation:

> Propose a plan for X, then have it reviewed by Clonst until consensus.

Claude calls `clonst_review`, applies the critiques (or rejects them with
justification, which Codex re-evaluates next round), and resubmits. You can
step in between rounds at any time.

Optional, for an even more assertive trigger policy, add to your `CLAUDE.md`:

```markdown
## Clonst
Any development that touches logic or behavior (business logic, data flows,
models, routes, APIs, state, error handling, concurrency, security, migrations)
MUST go through a clonst_review before being considered done. The criterion is
LOGIC, not size. Never for pure presentation, documentation, or renames.
```

## Configuration

`~/.clonst/config.json` (created on first save, editable by hand; invalid
values fall back to defaults with a warning):

```json
{
  "suggested_max_rounds": 5,
  "timeout_per_call_seconds": 600,
  "codex_model": null,
  "codex_reasoning_effort": null
}
```

- `suggested_max_rounds`: how often (in rounds) the calling LLM checks in with
  you on a review with no explicit limit. NOT a limit.
- `timeout_per_call_seconds`: per-round timeout on the codex CLI call.
- `codex_model` / `codex_reasoning_effort`: model and effort for reviews.
  `null` or absent = inherit from `~/.codex/config.toml` (shared with the Codex
  VS Code extension). Set them to give reviews their own setting without
  touching the extension. Values are passed as root `-c` overrides to the CLI
  (contract verified on codex 0.142.5 for both `exec` and `resume` via
  `scripts/probe-codex-config-override.ps1`); a value unknown to codex fails
  the review with codex's own error message.

## Logs and diagnostics

Each ping-pong lives under `~/.clonst/logs/<thread_id>.jsonl` (timestamped
events: rounds, verdicts, model/effort used, token usage) with the complete raw
responses in `~/.clonst/logs/raw/<thread_id>/` (codex JSONL stream, last
message, stderr). No paid response is ever lost, even when parsing fails.

## Common errors

| Symptom | Cause | Action |
|---|---|---|
| `kind: "cli_not_found"` | codex CLI missing from PATH | `npm install -g @openai/codex` |
| `kind: "exec_failed"` + login hint | ChatGPT session expired | `codex login` |
| `kind: "timeout"` | Review too long | Raise `timeout_per_call_seconds` in `~/.clonst/config.json` |
| `kind: "exec_failed"` + quota hint | ChatGPT usage limit reached (rolling window) | Continue without review; relaunch when the window resets (session resumable via thread_id if the ping-pong was already running) |
| `codex_available: false` on ping | CLI missing or broken | `codex --version` in a terminal |
| Long reviews fail while short ones pass | The MCP CLIENT's timeout (not Clonst's) | Launch Claude Code with `MCP_TOOL_TIMEOUT=600000` |

**Privacy**: with `project_path`, Codex reads the whole project read-only
(including `.env`) and that content goes to OpenAI - the same exposure as using
the Codex VS Code extension directly. Recommended strategy: by default, review
the content passed in `content` (no `project_path`); reserve `project_path`
for reviews where the reviewer must verify real APIs, contracts or files.

## Development

```
npm test          # build + hermetic test suite (no LLM calls)
npm run smoke     # full MCP protocol smoke test
```

The `scripts/probe-*.ps1` scripts probe the real codex CLI contract and consume
ChatGPT quota: manual execution only. Known limitation: developed and battle-
tested on Windows; the POSIX process-tree kill path is implemented and CI-tested
on Linux, but has seen less real-world use.

## Status

Functional and used daily by its author. Provided as is, without support
guarantees. Out of scope for now: Gemini provider (the `ReviewerProvider`
interface is ready), background orchestrator.
