import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeArg, spawnCLI } from "../utils/process.js";
import { logStderr } from "../utils/logger.js";
import {
  ProviderError,
  type ReviewInvocation,
  type ReviewInvocationResult,
  type ReviewerProvider,
} from "./base.js";

/**
 * JSONL contract of `codex exec --json`, pinned by the scripts/probe-codex*.ps1
 * probes (codex-cli 0.142.5):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"<response>"}}
 *   {"type":"turn.completed","usage":{"input_tokens":...,"output_tokens":...}}
 */
export interface ParsedCodexEvents {
  threadId: string | null;
  /** All agent messages, in emission order (the last one is authoritative). */
  agentMessages: string[];
  usage: Record<string, number> | null;
  /** Unparsable lines or unexpected structures (reported, never silent). */
  malformedLines: number;
}

/**
 * Reads the codex CLI's effective defaults from its config (~/.codex/config.toml,
 * or CODEX_HOME when set - the same variable the CLI itself uses).
 * Best-effort, for DISPLAY only: just the ROOT keys count, reading stops at the
 * first [section] table ([profiles.x] blocks carry their own model keys, which
 * do not apply here). null when the file is absent, unreadable or the key is
 * missing: codex's internal default cannot be known without spending quota, so
 * we show "unknown" rather than an invention.
 */
export function readCodexDefaults(): { model: string | null; reasoningEffort: string | null } {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const result: { model: string | null; reasoningEffort: string | null } = {
    model: null,
    reasoningEffort: null,
  };
  // Same whitelist as the overrides: exotic TOML (escapes, spaces...) becomes
  // null ("unknown") instead of an incorrectly displayed value.
  const safe = (value: string): string | null => (/^[A-Za-z0-9._-]+$/.test(value) ? value : null);
  try {
    const raw = readFileSync(path.join(home, "config.toml"), "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break; // end of the TOML root keys
      const model = line.match(/^\s*model\s*=\s*"([^"]+)"/);
      if (model) {
        result.model = safe(model[1]);
        continue;
      }
      const effort = line.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/);
      if (effort) result.reasoningEffort = safe(effort[1]);
    }
  } catch {
    // File absent or unreadable: defaults unknown, null assumed (display only)
  }
  return result;
}

export function parseCodexEvents(jsonl: string): ParsedCodexEvents {
  const result: ParsedCodexEvents = {
    threadId: null,
    agentMessages: [],
    usage: null,
    malformedLines: 0,
  };

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      result.malformedLines++;
      continue;
    }
    if (typeof event !== "object" || event === null) {
      result.malformedLines++;
      continue;
    }
    const e = event as Record<string, unknown>;

    if (e.type === "thread.started") {
      if (typeof e.thread_id === "string" && e.thread_id.length > 0) {
        result.threadId = e.thread_id;
      } else {
        result.malformedLines++;
      }
    } else if (e.type === "item.completed") {
      const item = (e.item ?? null) as Record<string, unknown> | null;
      if (item && item.type === "agent_message") {
        if (typeof item.text === "string") {
          result.agentMessages.push(item.text);
        } else {
          result.malformedLines++;
        }
      }
      // Other item types (reasoning, tool calls...) are legitimate and ignored.
    } else if (e.type === "turn.completed") {
      const usage = (e.usage ?? null) as Record<string, unknown> | null;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const numeric: Record<string, number> = {};
        for (const [key, value] of Object.entries(usage)) {
          if (typeof value === "number") numeric[key] = value;
        }
        result.usage = numeric;
      } else {
        result.malformedLines++;
      }
    }
    // Other event types (turn.started, ...) are ignored.
  }

  return result;
}

/**
 * Injection point for tests: lets a fixture replace the real codex CLI
 * (`command: "node", prefixArgs: [fixturePath]`) without touching the contract.
 * In production the defaults are used.
 */
export interface CodexRuntime {
  command: string;
  prefixArgs: string[];
}

const DEFAULT_RUNTIME: CodexRuntime = { command: "codex", prefixArgs: [] };

const INSTALL_HINT = "Install the CLI: npm install -g @openai/codex, then codex login";
const LOGIN_HINT = "Reconnect the CLI: codex login (auth is shared with the VS Code extension)";
const QUOTA_HINT_BASE =
  "Codex usage quota reached (ChatGPT subscription limit, rolling window). " +
  "Continue the work WITHOUT review and note what will need reviewing; ";
const QUOTA_HINT_RESUME =
  QUOTA_HINT_BASE +
  "the Codex session stays resumable later through the same thread_id, once the window resets.";
const QUOTA_HINT_NEW =
  QUOTA_HINT_BASE + "relaunch the review later (new session: no thread_id was created for this round).";

export class CodexProvider implements ReviewerProvider {
  readonly name = "codex";

  constructor(private readonly runtime: CodexRuntime = DEFAULT_RUNTIME) {}

  async isAvailable(): Promise<boolean> {
    try {
      const result = await spawnCLI(this.runtime.command, [...this.runtime.prefixArgs, "--version"], {
        timeoutMs: 15_000,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Builds the invocation arguments. Exposed for tests.
   * New session: `[-c ...] exec - --sandbox read-only ...`
   * Resume:      `[-c ...] exec resume <thread_id> - ...` (no --sandbox: the
   * resume subcommand rejects it, the sandbox is inherited from the session).
   * Model/effort overrides are ROOT-level codex `-c` flags (before the
   * subcommand), accepted uniformly by exec and resume: without them the CLI
   * uses ~/.codex/config.toml as before.
   */
  buildArgs(
    threadId: string | undefined,
    lastMessagePath: string,
    overrides?: { model?: string; reasoningEffort?: string }
  ): string[] {
    const args = [...this.runtime.prefixArgs];
    if (overrides?.model !== undefined) {
      args.push("-c", `model=${assertSafeArg(overrides.model, "codex_model")}`);
    }
    if (overrides?.reasoningEffort !== undefined) {
      args.push("-c", `model_reasoning_effort=${assertSafeArg(overrides.reasoningEffort, "codex_reasoning_effort")}`);
    }
    if (threadId !== undefined) {
      args.push("exec", "resume", assertSafeArg(threadId, "thread_id"), "-");
    } else {
      args.push("exec", "-", "--sandbox", "read-only");
    }
    args.push("--json", "--skip-git-repo-check", "--output-last-message", lastMessagePath);
    return args;
  }

  async invoke(invocation: ReviewInvocation): Promise<ReviewInvocationResult> {
    const { logger, tag } = invocation;
    const lastMessagePath = logger.rawPath(`${tag}_last-message.txt`);
    // Deterministic path: a file left by a previous invocation would be re-read
    // as if it came from this one (silent stale response). Removed BEFORE the spawn.
    try {
      rmSync(lastMessagePath, { force: true });
    } catch (err) {
      // force:true covers ENOENT; this is a lock/permission issue. Continuing
      // would risk re-reading a stale file: fail explicitly with context.
      throw new Error(
        `Cannot remove the stale last-message file (session ${logger.sessionId}, tag ${tag}): ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
    const args = this.buildArgs(invocation.threadId, lastMessagePath, {
      model: invocation.model,
      reasoningEffort: invocation.reasoningEffort,
    });

    let spawnResult;
    try {
      spawnResult = await spawnCLI(this.runtime.command, args, {
        cwd: invocation.cwd,
        timeoutMs: invocation.timeoutMs,
        stdin: invocation.prompt,
      });
    } catch (err) {
      throw new ProviderError(
        "cli_not_found",
        `Cannot launch the codex CLI: ${err instanceof Error ? err.message : String(err)}`,
        INSTALL_HINT
      );
    }

    // Raw save BEFORE any interpretation (rule: never lose a paid response)
    logger.saveRaw(`${tag}_stdout.jsonl`, spawnResult.stdout);
    if (spawnResult.stderr.trim()) {
      logger.saveRaw(`${tag}_stderr.txt`, spawnResult.stderr);
    }

    if (spawnResult.timedOut) {
      logger.log({ tag, actor: this.name, event: "timeout", duration_ms: spawnResult.durationMs });
      throw new ProviderError(
        "timeout",
        `codex did not respond within the allotted time (${spawnResult.durationMs} ms). ` +
          `Partial outputs are saved in the session logs.`
      );
    }

    if (spawnResult.exitCode !== 0) {
      const stderr = spawnResult.stderr.trim();
      // Locale-independent detection: cmd.exe returns 9009 for an unknown
      // command, sh returns 127. Text patterns (including localized Windows
      // messages) are only a secondary net.
      const notFound =
        spawnResult.exitCode === 9009 ||
        spawnResult.exitCode === 127 ||
        /not recognized|command not found|pas reconnu|introuvable/i.test(stderr);
      const authIssue = /login|logged out|unauthorized|401/i.test(stderr);
      const quotaIssue = /usage limit|rate limit|too many requests|quota|429/i.test(stderr);
      logger.log({
        tag,
        actor: this.name,
        event: notFound ? "cli_not_found" : "exec_failed",
        exit_code: spawnResult.exitCode,
        duration_ms: spawnResult.durationMs,
      });
      const hint = notFound
        ? INSTALL_HINT
        : quotaIssue
          ? invocation.threadId !== undefined
            ? QUOTA_HINT_RESUME
            : QUOTA_HINT_NEW
          : authIssue
            ? LOGIN_HINT
            : undefined;
      throw new ProviderError(
        notFound ? "cli_not_found" : "exec_failed",
        `codex failed (exit ${spawnResult.exitCode}).\nFull stderr:\n${stderr || "(empty)"}`,
        hint
      );
    }

    const events = parseCodexEvents(spawnResult.stdout);
    if (events.malformedLines > 0) {
      logStderr(`codex: ${events.malformedLines} unparsable JSONL line(s) (raw saved: ${tag}_stdout.jsonl)`);
    }

    // Primary source: the --output-last-message file written by the CLI itself.
    // Fallback: the last agent_message event of the JSONL stream.
    let text: string | null = null;
    try {
      const fromFile = readFileSync(lastMessagePath, "utf-8");
      if (fromFile.trim()) text = fromFile;
    } catch {
      // file absent: fall back to the JSONL stream
    }
    if (text === null && events.agentMessages.length > 0) {
      text = events.agentMessages[events.agentMessages.length - 1];
    }

    if (text === null) {
      logger.log({ tag, actor: this.name, event: "empty_response", duration_ms: spawnResult.durationMs });
      throw new ProviderError(
        "empty_response",
        `codex finished (exit 0) without a usable agent message. ` +
          `Raw stream saved: ${tag}_stdout.jsonl`
      );
    }

    if (events.threadId === null) {
      // Session resumption is Clonst's central mechanism: a response without a
      // thread_id makes the next round impossible, so this must be visible.
      logStderr(`codex: usable response but NO thread_id emitted (${tag}): session resumption will be impossible for this round`);
      logger.log({ tag, actor: this.name, event: "missing_thread_id" });
    } else if (invocation.threadId !== undefined && events.threadId !== invocation.threadId) {
      // Session divergence: the CLI re-emitted a thread_id different from the
      // resumed one. A serious anomaly (later rounds would target another
      // session), but not fatal: the response is already paid for and the
      // critique remains usable.
      logStderr(`codex: re-emitted thread_id (${events.threadId}) DIFFERS from the resumed one (${invocation.threadId}) - possible session divergence (${tag})`);
      logger.log({
        tag,
        actor: this.name,
        event: "thread_id_mismatch",
        requested: invocation.threadId,
        received: events.threadId,
      });
    }

    // Best-effort resolution of the model/effort actually used (for display in
    // the final report): requested override, else the ~/.codex/config.toml
    // default. Codex JSONL events do not expose the model (verified on 0.142.5).
    const defaults =
      invocation.model === undefined || invocation.reasoningEffort === undefined
        ? readCodexDefaults()
        : { model: null, reasoningEffort: null };
    const model = invocation.model ?? defaults.model;
    const reasoningEffort = invocation.reasoningEffort ?? defaults.reasoningEffort;

    logger.log({
      tag,
      actor: this.name,
      event: "invoke_ok",
      thread_id: events.threadId,
      resumed: invocation.threadId !== undefined,
      duration_ms: spawnResult.durationMs,
      usage: events.usage,
      model,
      reasoning_effort: reasoningEffort,
      // File name (not an absolute path): the session's raw directory may be
      // renamed by a migration, the name stays valid by construction.
      last_message_file: `${tag}_last-message.txt`,
    });

    return {
      text,
      threadId: events.threadId,
      durationMs: spawnResult.durationMs,
      usage: events.usage,
      model,
      reasoningEffort,
    };
  }
}
