import type { SessionLogger } from "../utils/logger.js";

export type ProviderErrorKind =
  /** The CLI is not installed or not on the PATH. */
  | "cli_not_found"
  /** The CLI returned a non-zero exit code (expired auth, quota, crash...). */
  | "exec_failed"
  /** The CLI exceeded the timeout and was killed. */
  | "timeout"
  /** The CLI finished without producing a usable agent message. */
  | "empty_response";

/**
 * Typed provider error. `hint` is a concrete action for the user
 * (e.g. "codex login"), forwarded as is to the calling LLM which presents it.
 * The complete raw outputs are already saved to disk by the time this error is
 * thrown (rule: never lose a paid response).
 */
export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly hint?: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ReviewInvocation {
  /** The complete prompt (goes through the CLI's stdin, never as an argument). */
  prompt: string;
  /** Project directory: the CLI is spawned there and can read the files. */
  cwd?: string;
  /** Session resume: identifier returned by a previous invocation. */
  threadId?: string;
  /** Timeout in milliseconds (default: spawnCLI's, 10 min). */
  timeoutMs?: number;
  /** Prefix of this invocation's raw files (e.g. "round_2"). */
  tag: string;
  /** Logger of the current Clonst session (JSONL + raw responses). */
  logger: SessionLogger;
  /** Model to use for this review (absent = the provider CLI's default). */
  model?: string;
  /** Reasoning effort to use (absent = the provider CLI's default). */
  reasoningEffort?: string;
}

export interface ReviewInvocationResult {
  /** The agent's last message (raw text, parsed by the consensus layer). */
  text: string;
  /** Session identifier to reuse for the next round (null if not emitted). */
  threadId: string | null;
  durationMs: number;
  /** Token usage reported by the CLI, when available. */
  usage: Record<string, number> | null;
  /**
   * Model actually used, best-effort for display: the requested override,
   * otherwise the default read from the CLI's config, otherwise null (unknown).
   */
  model: string | null;
  /** Reasoning effort actually used (same best-effort resolution). */
  reasoningEffort: string | null;
}

export interface ReviewerProvider {
  readonly name: string;
  /** Checks that the CLI is installed and responds (without consuming LLM quota). */
  isAvailable(): Promise<boolean>;
  /** Sends a prompt (new session or resume) and returns the agent's response. */
  invoke(invocation: ReviewInvocation): Promise<ReviewInvocationResult>;
}
