# Clonst - Project instructions

## What Clonst is

A TypeScript MCP server (stdio) that lets the Claude of a Claude Code
conversation get its plans/code critiqued by the Codex CLI, in a ping-pong
loop until consensus.

Architecture:
- **The reviser is the calling Claude** (the one in the conversation), not a
  spawned `claude` CLI. It keeps the whole conversation context.
- **The reviewer is the Codex CLI** (`codex exec`), with persistent memory
  across rounds through `codex exec resume <session_id>`.
- The ping-pong loop lives in the calling conversation: one MCP call = one
  critique. No background orchestrator, no status tool.

## Non-negotiable technical rules

- **stdout is reserved for the MCP protocol** (stdio transport). All logging
  goes to stderr or files.
- **Prompts go through the CLIs' stdin, never as arguments** (Windows quoting,
  ~8 KB limit, injection).
- Spawn arguments contain only fixed flags plus whitelist-validated
  identifiers; never free-form variable content.
- Clean the inherited environment before spawning an LLM CLI (strip
  `CLAUDECODE`, `CLAUDE_CODE_*`).
- Always save a CLI's complete raw response before attempting to parse it.
- Long timeouts (300 s and more, configurable): reasoning models take minutes.
- Verdict detection: JSON first, anchored regex fallback
  (`"verdict"\s*:\s*"APPROVED"`), never `includes("approved")` (false positive
  on "not approved"). An APPROVED recovered by any fallback never reaches
  consensus.
- Atomic writes for config/state files (tmp + rename).
- The real codex CLI contract (JSONL events, flags accepted by exec vs resume)
  is pinned by the probe scripts in `scripts/probe-*.ps1`; re-run them manually
  if a codex update breaks something.

## Build and MCP registration

`.mcp.json` points to `dist/index.js`, which is gitignored: `npm run build` is
mandatory after cloning or changing `src/` for Claude Code to see an up-to-date
server. LLM-free smoke test: `npm run smoke` (spawns the server, checks
initialize / tools/list / clonst_ping).

## Tests

Never run commands that consume LLM quota (`scripts/probe-*.ps1`, real
`codex exec` calls). Give the user the commands to copy-paste instead.
`npm run build`, `npm test` and the local MCP smoke tests are hermetic (no LLM
call) and always allowed.
