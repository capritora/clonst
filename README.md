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

- **Zero ritual.** Install it and forget it: Claude triggers the review by
  itself, and only when the change is worth your quota.
- **Ping-pong until consensus.** Unlimited rounds by default. Structured
  verdicts (APPROVED / CHANGES_NEEDED), required changes, suggestions, risks.
  Claude can reject a critique with justification; Codex re-evaluates the
  rejection next round.
- **Real session memory.** Codex resumes the same CLI session on every round
  and remembers its earlier critiques. No context re-sending, no goldfish
  reviewer.
- **Your ChatGPT subscription, no API keys.** Reviews go through the official
  `codex` CLI and its existing login.
- **Pick your reviewer.** By default, reviews use the model and reasoning
  effort your codex CLI is already configured with. One line in
  `~/.clonst/config.json` gives reviews their own setting (e.g. a faster,
  cheaper effort) without touching your Codex extension - see Configuration.
- **Cost transparency.** The final report shows the reviewer model, rounds,
  total duration and tokens consumed - fresh tokens headlined, cache re-serves
  set apart so cumulative totals never look scarier than they are.
- **An audit trail that survives the conversation.** Each review writes a
  structured Markdown report (plain-language summary + every round's demands,
  changes and rejections, verbatim) under `~/.clonst/reports/`.
- **Intent drift is a first-class check.** The reviewer measures the
  deliverable against your stated goal, not just against technical standards -
  a "fix" that silently changes the behavior you wanted gets flagged, and
  product choices are routed to you instead of being decided by an LLM.
- **Collateral damage is hunted on both sides.** Before demanding a change,
  the reviewer must check what else that change would break (callers,
  contracts, distant modules); before applying one, Claude must do the same -
  and a rejection for collateral damage comes with a safer alternative, not a
  bare veto.
- **Your project's own review rules.** Drop a `CLONST.md` at the project root
  and the reviewer checks your conventions on top of its own standards.
  CLAUDE.md guides the writer; CLONST.md guides the reviewer.
- **Reviews in your language.** Critiques come back in the language you work
  in (per call, or once for all with `default_language` in the config), while
  the protocol stays machine-readable English.
- **Nothing is ever lost.** Every raw reviewer response is saved to disk
  before any parsing.
- **Cross-platform.** Windows, macOS and Linux, all three covered by the CI.
- **Hardened.** Prompt-injection guards, read-only sandbox, whitelisted CLI
  arguments, hermetic test suite (no LLM call, no quota).

## When does it trigger?

You never have to ask. Claude decides when a review is worth your quota, and
the rule is **stakes, not size**:

| Reviews by itself | Stays silent |
|---|---|
| Business logic, computations | Pure presentation (HTML/CSS, copy) |
| Data flows, models, migrations | Documentation, comments |
| Routes, APIs, integrations | Renames without behavior change |
| State, error handling, concurrency | Local config tweaks |
| Security, authentication | Throwaway scripts and prototypes |
| Plans and architecture, before coding | (when in doubt, it asks you) |

The ping-pong is **unlimited by default**: it runs until consensus, checking in
with you every 5 rounds (configurable). And you can cap any review in plain
language: "review this, 3 rounds max".

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
`thread_id`, until `consensus: true`. The loop is driven through the caller (the
`thread_id` travels with each call), while the server keeps per-session
records on disk: full logs, the previous round's verdict for exact recall,
the running duration/token totals, and the structured review report
(regenerated at every round). Codex sessions persist on the CLI side.

## Quick start

**Requirements**:

- [Claude Code](https://claude.com/claude-code) - the terminal CLI or the
  VS Code / JetBrains extensions, which share the same MCP configuration
- Node.js 22+
- The Codex CLI, logged in with a ChatGPT plan:

```
npm install -g @openai/codex
codex login
```

**Install Clonst** (recommended, via npm):

```
claude mcp add clonst --scope user -- npx -y @clonst/clonst
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

Reviews happen on their own, but you can also steer them:

> Propose a plan for X, then have it reviewed by Clonst until consensus.

> Have this migration reviewed by Clonst, 3 rounds max.

> Ask Clonst for a security-focused review of this auth flow.

You see each revision happen in the conversation, and at consensus Claude ends
with a short report, for example:

> Clonst review: GPT-5.5 (high effort), 2 rounds, 5 min 30 s, ~210k fresh
> input plus 18k output tokens (cumulative input 2.8M, of which 2.6M were
> cache re-serves). The reviewer required an anti-double-correction bound on
> the migration and a timeout on the API call, both applied. I rejected one
> suggestion (out of MVP scope) and the reviewer accepted the justification.
> Full round-by-round report: ~/.clonst/reports/2026-07-06-a3f1...md

Want the round-by-round detail? Just ask ("walk me through the rounds"): Claude
holds the whole exchange and reports it on demand.

## The review report file

Every review also writes a structured Markdown report under
`~/.clonst/reports/`, updated at each round - so the audit survives the
conversation. It opens with the plain-language summary (sealed verbatim after
consensus), then one section per round with the exact words each party used:

- what the reviewer required, suggested and flagged as risky (verbatim),
- what the reviser declared changed or rejected before each round (verbatim),
- per-round model, effort, duration and tokens, plus whole-review totals,
- an audit trail pointing to the session log and the raw reviewer output.

The file is a pure projection of a server-side state: nothing is reworded
after the fact, and LLM-originated text is escaped so it cannot fake report
sections. A report that starts mid-session (resumed thread) is explicitly
flagged **PARTIAL HISTORY**. Two identifiers, two jobs: `report_id` names the
report file, `thread_id` resumes the reviewer session.

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
| `context` | none | Round 1: the reviewer's yardstick - goal, intended behavior, non-goals, constraints, decisions already made. The intent-drift check measures the deliverable against it |
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
(best-effort resolution: override, else codex config, else null),
`report_id` / `report_path` (the structured report file; `report_error` when
it could not be written - the review itself is unaffected), and a
`next_action` instruction (text + typed fields) that drives the loop.

### clonst_report_summary

Seals the plain-language summary into the review report file, verbatim, after
consensus. Takes `report_id` (returned by clonst_review - not `thread_id`) and
`summary`. Metadata-only: no reviewer spawn, no quota, idempotent.

## Configuration

Optional file, absent by default: create `~/.clonst/config.json` yourself to
change any key. It is re-read on every call; invalid values fall back to the
default with a warning.

| Key | Default | What it does |
|---|---|---|
| `codex_model` | `null` = inherit `~/.codex/config.toml` | Model used for reviews only (e.g. `"gpt-5.5"`). Your Codex VS Code extension keeps its own setting |
| `codex_reasoning_effort` | `null` = inherit | Reasoning effort for reviews only (e.g. `"medium"`, `"high"`, `"xhigh"`). Lower = faster, cheaper rounds |
| `default_language` | `null` = language of the reviewed content | Language of the critiques when the caller does not pass one, as a code like `"fr"` or `"pt-BR"` |
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

### Project review guidelines: CLONST.md

Put a `CLONST.md` at the project root and, whenever a review runs with
`project_path`, its content is handed to the reviewer as project-specific
guidelines - your conventions, your red lines, checked on top of the
reviewer's own standards. Example:

```markdown
# Review guidelines
- SQL must stay compatible with BOTH SQLite (dev) and PostgreSQL (prod).
- Every new route needs rate limiting.
- LLM results must be matched by ID, never by list position.
```

Business invariants belong here too - the red lines the intent-drift check
should defend. Make them concrete and checkable: do not write "keep it
simple"; write "free users must be able to export CSV" or "checkout must stay
one-click".

Guidelines can only ADD checks: a guideline trying to lower the bar or force
a verdict is ignored and reported as a risk.

### Intent drift and user decisions

The review is not only technical: before checking code quality, the reviewer
compares the deliverable with the intent you stated (`context`, CLONST.md) or
that is evident from the project. It never invents your product goals - when
it spots a possible product preference rather than a proven contradiction, it
emits a risk starting with the literal marker `USER DECISION: `. Any such item
must reach you verbatim as an open question: mid-review it pauses the
ping-pong before anything else happens, and at consensus it lands in the
final report and the report file. Claude may not decide it, execute it, or
drop it. A proven silent change of user-visible behavior, on the other hand,
can block the review outright.

The scrutiny is symmetric. Claude does not apply critiques blindly: each
demand is checked for factual correctness, intent fit and blast radius
(what else depends on the thing being changed) before being applied - and a
demand that would break something else is rejected with a justification and a
safer alternative, which the reviewer must engage with rather than repeat
itself. Both models argue toward a solution; deadlocks go to you.

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
- **Review content persists locally outside the conversation**: session logs
  and raw reviewer responses under `~/.clonst/logs/`, and the human-readable
  reports (critiques and change declarations verbatim) under
  `~/.clonst/reports/`. Delete those directories to purge past reviews.
- One Clonst server instance per conversation is the operating model; report
  writes are serialized in-process. Do not point two concurrently running
  servers at the same `CLONST_HOME`.

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
