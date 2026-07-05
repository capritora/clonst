# Clonst - AI code review for Claude Code, powered by Codex

[![CI](https://github.com/capritora/clonst/actions/workflows/ci.yml/badge.svg)](https://github.com/capritora/clonst/actions/workflows/ci.yml)

**Get a second AI opinion on your code before it ships.** Clonst is a Model
Context Protocol (MCP) server that connects Claude Code to OpenAI Codex for
adversarial code review: Claude writes the plan or the code, Codex critiques
it, Claude revises, and the loop repeats until both models reach consensus.
It runs on your existing ChatGPT subscription through the official Codex CLI.
No API keys, no extra billing.

> Independent project. Not affiliated with OpenAI ("Codex", "ChatGPT") or
> Anthropic ("Claude").

## Why a second model?

An LLM reviewing its own output shares its own blind spots. A second model,
from a different provider, with its own training and its own memory, catches
what the first one missed: wrong assumptions, missing edge cases, fragile
migrations, race conditions, security holes. Clonst turns that into a
structured review loop with a hard exit criterion: consensus, not politeness.

## Features

- **Zero ritual.** Once installed, Claude calls the review by itself for any
  change that touches logic or behavior. You just work.
- **Ping-pong until consensus.** Structured verdicts (APPROVED /
  CHANGES_NEEDED), required changes, suggestions, risks. Claude can reject a
  critique with justification; Codex re-evaluates the rejection next round.
- **Real session memory.** Codex resumes the same CLI session on every round
  and remembers its earlier critiques. No context re-sending, no goldfish
  reviewer.
- **Your ChatGPT subscription, no API keys.** Reviews go through the official
  `codex` CLI and its existing login.
- **Cost transparency.** The final report shows the reviewer model, rounds,
  total duration and tokens consumed.
- **Reviews in your language.** Critiques come back in the language you work
  in, while the protocol stays machine-readable English.
- **Nothing is ever lost.** Every raw reviewer response is saved to disk
  before any parsing.
- **Cross-platform.** Windows, macOS and Linux, all three covered by the CI.
- **Hardened.** Prompt-injection guards, read-only sandbox, whitelisted CLI
  arguments, hermetic test suite (no LLM call, no quota).

## How it works

```
You ── conversation ── Claude (reviser, keeps the conversation context)
                          │
                          │  clonst_review (MCP, one call = one critique)
                          ▼
                       Clonst ── spawn ── codex exec [resume <thread_id>]
                                             (reviewer, keeps its session)
```

The loop lives on Claude's side: it submits, Codex critiques, Claude revises
in the conversation (in front of you), resubmits with the returned
`thread_id`, until `consensus: true`. The server is stateless between calls;
Codex sessions persist on disk on the CLI side.

## Quick start

**Requirements**: Node.js 22+, and the Codex CLI logged in with a ChatGPT plan:

```
npm install -g @openai/codex
codex login
```

**Install Clonst** (recommended, via npm):

```
claude mcp add clonst --scope user -- npx -y @capritora/clonst
```

Or from source:

```
git clone https://github.com/capritora/clonst.git && cd clonst
npm install && npm run build
claude mcp add clonst --scope user -- node /absolute/path/to/clonst/dist/index.js
```

**Check it works**: in a new Claude Code conversation, say "ping clonst".
Expected: `codex_available: true`, `codex_logged_in: true`.

## What a review looks like

Nothing to remember: the tool description tells Claude to request a review by
default for any development that touches logic or behavior, and to skip it for
pure presentation or documentation. You can also ask explicitly:

> Propose a plan for X, then have it reviewed by Clonst until consensus.

You see each revision happen in the conversation, and at consensus Claude ends
with a short report, for example:

> Clonst review: GPT-5.5 (high effort), 2 rounds, 5 min 30 s, ~500k tokens.
> The reviewer required an anti-double-correction bound on the migration and a
> timeout on the API call, both applied. I rejected one suggestion (out of MVP
> scope) and the reviewer accepted the justification.

## Tools

### clonst_ping

Server health: codex CLI availability, version, login status, loaded config,
logs directory. Consumes no quota.

### clonst_review

One structured critique per call. Parameters (all drive the calling LLM; you
normally never write these yourself):

| Parameter | Default | Role |
|---|---|---|
| `content` (required) | - | The plan/code to review, complete (later rounds: the full revised version, never a diff) |
| `context` | none | Round 1: goal, constraints, decisions already made |
| `project_path` | none | ABSOLUTE project path: Codex runs there and reads the real files (read-only sandbox). See Privacy below |
| `thread_id` | none | Later rounds: the identifier returned by the previous call (resumes the Codex session) |
| `round` | 1 (2 with thread_id) | Round number; hard safety cap at 50 |
| `max_rounds` | unlimited | Hard round limit for this review; at the limit, disagreement goes to the user |
| `language` | language of the content | Code like "fr" or "pt-BR": the reviewer writes critiques in that language. Resolved server-side; the raw value never reaches the prompt |
| `review_focus` | all | bugs, architecture, performance, security, or all |
| `changes_made` / `changes_rejected` | none | Later rounds: what was changed / rejected with justification |

Result: `verdict`, `consensus` (true only on a proven APPROVED: clean JSON,
zero required changes, no fallback parsing), `critique`, `required_changes`,
`suggestions`, `risks_identified`, `thread_id`, per-round and whole-review
duration and token usage, `reviewer_model` / `reviewer_reasoning_effort`
(best-effort resolution: override, else codex config, else null), and a
`next_action` instruction (text + typed fields) that drives the loop.

## Configuration

`~/.clonst/config.json`, created on first use, re-read on every call. All keys
are optional; invalid values fall back to the default with a warning.

| Key | Default | What it does |
|---|---|---|
| `codex_model` | `null` = inherit `~/.codex/config.toml` | Model used for reviews only (e.g. `"gpt-5.5"`). Your Codex VS Code extension keeps its own setting |
| `codex_reasoning_effort` | `null` = inherit | Reasoning effort for reviews only (e.g. `"medium"`, `"high"`, `"xhigh"`). Lower = faster, cheaper rounds |
| `suggested_max_rounds` | `5` | Without an explicit limit, Claude checks in with you every N rounds (5, 10, 15...) before continuing. NOT a limit |
| `timeout_per_call_seconds` | `600` | Timeout of one Codex call (reasoning models take minutes) |

Example, reviews at high effort while your extension stays at xhigh:

```json
{
  "codex_reasoning_effort": "high"
}
```

Overrides are passed as root `-c` flags to the codex CLI (contract verified on
codex 0.142.5 for both `exec` and `resume`); a value unknown to codex fails the
review with codex's own error message.

### Round limits: unlimited by default

Say nothing and the ping-pong continues until consensus, with a check-in every
`suggested_max_rounds` rounds. Or ask in natural language ("review this,
3 rounds max"): the reviewer is told about the counter (exhaustive from
round 1, maximum effort on the final round, never approving just to close),
and at the limit the disagreement goes to you for arbitration.

## Privacy and quota

- **Every review round consumes your ChatGPT subscription quota** (Codex does
  the reviewing). When the quota window is exhausted, Clonst detects it and
  tells Claude to continue without review; the session stays resumable later
  through the same `thread_id`.
- **With `project_path`, Codex reads the whole project read-only** (including
  `.env`) and that content goes to OpenAI - the same exposure as using the
  Codex VS Code extension directly. Default strategy: review the content
  passed in `content` only; reserve `project_path` for reviews that must
  verify real APIs, contracts or files.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `kind: "cli_not_found"` | codex CLI missing from PATH | `npm install -g @openai/codex` |
| `kind: "exec_failed"` + login hint | ChatGPT session expired | `codex login` |
| `kind: "timeout"` | Review too long | Raise `timeout_per_call_seconds` in `~/.clonst/config.json` |
| `kind: "exec_failed"` + quota hint | ChatGPT usage limit reached (rolling window) | Continue without review; relaunch when the window resets |
| `codex_available: false` on ping | CLI missing or broken | `codex --version` in a terminal |
| Long reviews fail while short ones pass | The MCP CLIENT's timeout (not Clonst's) | Launch Claude Code with `MCP_TOOL_TIMEOUT=600000` |
| Odd behavior after changing the source | `dist/` is gitignored | `npm run build` |

Each ping-pong is fully logged under `~/.clonst/logs/<thread_id>.jsonl`, with
complete raw responses in `~/.clonst/logs/raw/<thread_id>/`.

## Development

```
npm test          # build + hermetic test suite (no LLM calls)
npm run smoke     # full MCP protocol smoke test
```

The `scripts/probe-*.ps1` scripts pin the real codex CLI contract and consume
ChatGPT quota: manual execution only. The `ReviewerProvider` interface is ready
for other reviewer CLIs (e.g. Gemini).

## License

MIT. Provided as is, without support guarantees. Used daily by its author.
