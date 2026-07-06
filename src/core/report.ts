import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logStderr } from "../utils/logger.js";
import { reportsDir, reportStateDir } from "../utils/paths.js";
import { formatDuration, usageSummary } from "../utils/usage.js";

/**
 * Structured review report (v1.2): a human-readable Markdown file so a dev can
 * audit what the ping-pong concretely did after the conversation is gone.
 *
 * Invariants (Codex-reviewed design):
 * - The Markdown file is ALWAYS a pure projection of the state file: no code
 *   path edits the Markdown directly, so a regeneration can never lose data.
 * - The report is identified by a server-generated report_id, independent of
 *   the reviewer's thread_id (which may never be emitted): sealing a summary
 *   works even for sessions without a thread_id.
 * - report_path is created once (round 1) and persisted: a thread resumed the
 *   next day updates the SAME file.
 * - All read-modify-write cycles are serialized through an in-process
 *   per-report mutex (one MCP server instance per conversation is the operating
 *   model; cross-process locking is out of scope, documented in the README).
 * - All LLM/caller-originated text is copied verbatim but NEUTRALIZED so it
 *   cannot spoof the report structure (fenced summary, escaped list items).
 * - Report generation must never fail a review: recordRound catches everything
 *   and reports the error as data.
 */

export interface ReportRound {
  round: number;
  verdict: string;
  required_changes: string[];
  suggestions: string[];
  risks_identified: string[];
  /** Reviser's declarations passed on this round's call (rounds >= 2). */
  changes_made: string | null;
  changes_rejected: string | null;
  duration_seconds: number;
  usage: Record<string, number> | null;
  reviewer_model: string | null;
  reviewer_reasoning_effort: string | null;
}

export interface ReportState {
  report_id: string;
  report_path: string;
  /** ISO date (YYYY-MM-DD) of the report's creation, part of the filename. */
  created: string;
  thread_id: string | null;
  /** false when the report was started mid-session (cold resume, recovered corruption). */
  history_complete: boolean;
  consensus: boolean;
  /** Caller-provided plain-language summary, sealed after consensus. */
  summary: string | null;
  total_duration_seconds: number;
  total_usage: Record<string, number> | null;
  session_log: string;
  raw_dir: string;
  rounds: ReportRound[];
}

export interface RecordRoundInput {
  /** report_id recalled from the session state, when the session already has a report. */
  previousReportId: string | null;
  threadId: string | null;
  sessionLogPath: string;
  rawDirPath: string;
  round: ReportRound;
  consensus: boolean;
  totalDurationSeconds: number;
  totalUsage: Record<string, number> | null;
}

export interface RecordRoundResult {
  reportId: string | null;
  reportPath: string | null;
  /** Non-null when the report could not be written; the review itself is unaffected. */
  reportError: string | null;
}

const REPORT_ID_PATTERN = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** Raised on sealing errors the caller can act on (unknown report, bad id). */
export class ReportError extends Error {}

// ---------------------------------------------------------------------------
// Per-report in-process mutex (promise chain). The map entry is removed once
// its chain settles and no newer waiter replaced it, so it never grows beyond
// the reports concurrently in flight.
// ---------------------------------------------------------------------------

const reportLocks = new Map<string, Promise<void>>();

async function withReportLock<T>(reportId: string, fn: () => T): Promise<T> {
  const tail = reportLocks.get(reportId) ?? Promise.resolve();
  const run = tail.then(() => fn());
  const guard = run.then(
    () => undefined,
    () => undefined
  );
  reportLocks.set(reportId, guard);
  void guard.then(() => {
    if (reportLocks.get(reportId) === guard) reportLocks.delete(reportId);
  });
  return run;
}

// ---------------------------------------------------------------------------
// State persistence (atomic: tmp + rename)
// ---------------------------------------------------------------------------

function writeAtomic(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  // Unique temp name: harmless in the accepted single-process model, cheap
  // insurance if that model ever changes (Codex review suggestion).
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

function statePath(reportId: string): string {
  // Defense in depth: every caller validates upstream, but any id reaching a
  // filesystem path MUST match the whitelist (no separators, no dot-only names).
  if (!REPORT_ID_PATTERN.test(reportId)) {
    throw new ReportError(`Invalid report_id: "${reportId}"`);
  }
  return path.join(reportStateDir(), `${reportId}.json`);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidUsage(value: unknown): value is Record<string, number> | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isNonNegativeNumber);
}

function isValidRound(value: unknown): value is ReportRound {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.round === "number" &&
    Number.isInteger(r.round) &&
    r.round >= 1 &&
    typeof r.verdict === "string" &&
    isStringArray(r.required_changes) &&
    isStringArray(r.suggestions) &&
    isStringArray(r.risks_identified) &&
    isStringOrNull(r.changes_made) &&
    isStringOrNull(r.changes_rejected) &&
    isNonNegativeNumber(r.duration_seconds) &&
    isValidUsage(r.usage) &&
    isStringOrNull(r.reviewer_model) &&
    isStringOrNull(r.reviewer_reasoning_effort)
  );
}

/**
 * Full structural validation (Codex review): a state that PARSES but is
 * mistyped must be treated exactly like unparsable JSON, otherwise it either
 * blocks report generation on every subsequent round (reportError forever) or,
 * worse, redirects the report write outside ~/.clonst/reports/ through a
 * tampered report_path.
 */
function isValidState(value: unknown, expectedReportId: string): value is ReportState {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (s.report_id !== expectedReportId) return false;
  if (typeof s.report_path !== "string") return false;
  if (typeof s.created !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.created)) return false;
  // The report file must be EXACTLY the expected one (<created>-<report_id>.md
  // directly under reportsDir()): plain containment would still accept a
  // tampered path pointing at another file inside reports/ (Codex review).
  const expectedPath = path.resolve(reportsDir(), `${s.created}-${expectedReportId}.md`);
  if (path.resolve(s.report_path) !== expectedPath) return false;
  return (
    isStringOrNull(s.thread_id) &&
    isStringOrNull(s.thread_id) &&
    typeof s.history_complete === "boolean" &&
    typeof s.consensus === "boolean" &&
    isStringOrNull(s.summary) &&
    isNonNegativeNumber(s.total_duration_seconds) &&
    isValidUsage(s.total_usage) &&
    typeof s.session_log === "string" &&
    typeof s.raw_dir === "string" &&
    Array.isArray(s.rounds) &&
    s.rounds.every(isValidRound)
  );
}

/**
 * Loads a report state. Returns null when absent. A corrupt OR mistyped file
 * is renamed aside (kept, never deleted) and reported as null: the caller
 * restarts with history_complete=false.
 */
function loadState(reportId: string): ReportState | null {
  const filePath = statePath(reportId);
  if (!existsSync(filePath)) return null;
  let reason: string;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    if (isValidState(parsed, reportId)) return parsed;
    reason = "parsable JSON but invalid structure";
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  const aside = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, aside);
    logStderr(`corrupt report state for "${reportId}" kept aside as ${path.basename(aside)}`);
  } catch {
    logStderr(`corrupt report state for "${reportId}" could not be renamed aside`);
  }
  logStderr(`report "${reportId}" restarts with a partial history (${reason})`);
  return null;
}

function saveState(state: ReportState): void {
  writeAtomic(statePath(state.report_id), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Markdown neutralization: verbatim content, structure spoofing impossible
// ---------------------------------------------------------------------------

/** Opening/closing fence strictly longer than the longest backtick run in the text (min 3). */
function fenceFor(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Neutralizes a leading Markdown structure marker, even after indentation
 * (Codex review: column 0 alone is not enough). Covers ATX headings, block
 * quotes, list bullets, ordered lists, fences, HTML, tables and setext
 * underlines. The text itself is never truncated or reworded.
 */
function neutralizeLine(line: string): string {
  const ordered = line.match(/^(\s*)(\d+)([.)])(.*)$/);
  if (ordered) return `${ordered[1]}${ordered[2]}\\${ordered[3]}${ordered[4]}`;
  return line.replace(/^(\s*)([#>\-*+`<|=~_])/, "$1\\$2");
}

/**
 * Renders verbatim text as one list item; extra lines stay inside the item,
 * neutralized. A bare \r counts as a line ending too (Codex review): some
 * Markdown renderers treat it as a line break, so "safe\r## FAKE" would
 * otherwise smuggle a real heading past the neutralization.
 */
function listItem(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  const first = neutralizeLine(lines[0] ?? "");
  const rest = lines.slice(1).map((line) => `  ${neutralizeLine(line)}`);
  return [`- ${first}`, ...rest].join("\n");
}

function verbatimList(items: string[]): string {
  if (items.length === 0) return "- (none)";
  return items.map(listItem).join("\n");
}

/** Multi-line free text inside a code fence that its content cannot close. */
function fencedBlock(text: string): string {
  const fence = fenceFor(text);
  return `${fence}text\n${text}\n${fence}`;
}

// ---------------------------------------------------------------------------
// Rendering: the Markdown file is a pure projection of the state
// ---------------------------------------------------------------------------

export function renderReport(state: ReportState): string {
  const sortedRounds = [...state.rounds].sort((a, b) => a.round - b.round);
  const lastRound = sortedRounds[sortedRounds.length - 1];
  const status = state.consensus
    ? `CONSENSUS - ${lastRound?.verdict ?? "APPROVED"} at round ${lastRound?.round ?? "?"}`
    : `REVIEW IN PROGRESS - last verdict ${lastRound?.verdict ?? "(none)"} at round ${lastRound?.round ?? "?"}`;

  const lines: string[] = [
    "# Clonst review report",
    "",
    `- Status: ${status}`,
    `- Rounds recorded: ${sortedRounds.length} | Total duration: ${formatDuration(state.total_duration_seconds)}`,
    `- Tokens: ${usageSummary(state.total_usage)}`,
    `- Reviewer thread: ${state.thread_id ?? "(none emitted)"}`,
    `- Report ID: ${state.report_id}`,
    `- Created: ${state.created}`,
  ];

  // Placed BEFORE the summary (Codex review): a reader must never take a
  // partial audit for a complete one.
  if (!state.history_complete) {
    lines.push(
      "",
      "> **PARTIAL HISTORY** - this report was started from an already ongoing",
      "> reviewer session (or after a state recovery). Earlier rounds are missing;",
      "> only the rounds listed below are covered."
    );
  }

  lines.push("", "## Summary", "");
  if (state.summary !== null) {
    lines.push("_Reviser-provided plain-language summary, verbatim:_", "", fencedBlock(state.summary));
  } else {
    lines.push("_(not provided - the reviser has not sealed a summary into this report)_");
  }

  for (const round of sortedRounds) {
    lines.push("", `## Round ${round.round} - ${round.verdict}`, "");
    const reviewer =
      round.reviewer_model !== null || round.reviewer_reasoning_effort !== null
        ? `${round.reviewer_model ?? "unknown"} (${round.reviewer_reasoning_effort ?? "unknown"})`
        : "(reviewer CLI defaults)";
    lines.push(
      `- Reviewer: ${reviewer} | Duration: ${formatDuration(round.duration_seconds)}`,
      `- Tokens: ${usageSummary(round.usage)}`
    );
    if (round.round > 1) {
      lines.push("", "### Revision submitted before this round (reviser's words, verbatim)", "");
      lines.push(
        round.changes_made !== null ? `Changes made:\n${listItem(round.changes_made)}` : "Changes made: (not provided)"
      );
      lines.push(
        round.changes_rejected !== null
          ? `Changes rejected:\n${listItem(round.changes_rejected)}`
          : "Changes rejected: (not provided)"
      );
    }
    lines.push("", "### Reviewer verdict (reviewer's words, verbatim)", "");
    lines.push(`Required changes:\n${verbatimList(round.required_changes)}`);
    lines.push("", `Suggestions:\n${verbatimList(round.suggestions)}`);
    lines.push("", `Risks identified:\n${verbatimList(round.risks_identified)}`);
  }

  lines.push(
    "",
    "## Audit trail",
    "",
    `- Session log (JSONL): ${state.session_log}`,
    `- Raw reviewer output: ${state.raw_dir}`,
    `- Report state: ${statePath(state.report_id)}`,
    ""
  );

  return lines.join("\n");
}

function writeReportFile(state: ReportState): void {
  writeAtomic(state.report_path, renderReport(state));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records one review round into the report (creating it on first sight) and
 * regenerates the Markdown file. NEVER throws: a report failure must not fail
 * the review; it is returned as data (reportError) so the tool result and the
 * next_action can reflect it.
 */
export async function recordRound(input: RecordRoundInput): Promise<RecordRoundResult> {
  // A recalled id that fails the whitelist (tampered session state, foreign
  // caller) is treated like a lost state: fresh report, partial history. It
  // must never reach a filesystem path, and it must not cost the user the
  // report either (never-fail contract).
  const previousReportId =
    input.previousReportId !== null && REPORT_ID_PATTERN.test(input.previousReportId)
      ? input.previousReportId
      : null;
  if (previousReportId === null && input.previousReportId !== null) {
    logStderr(`invalid recalled report_id ignored, starting a fresh report`);
  }
  const reportId = previousReportId ?? randomUUID();
  try {
    return await withReportLock(reportId, () => {
      let state = previousReportId !== null ? loadState(previousReportId) : null;
      if (state === null) {
        const created = new Date().toISOString().slice(0, 10);
        state = {
          report_id: reportId,
          report_path: path.join(reportsDir(), `${created}-${reportId}.md`),
          created,
          thread_id: null,
          // Complete only when the report starts at round 1. A recalled
          // report_id whose state vanished (corruption, manual deletion)
          // restarts partial even at a re-run round 1: rounds may be missing.
          history_complete: input.previousReportId === null && input.round.round === 1,
          consensus: false,
          summary: null,
          total_duration_seconds: 0,
          total_usage: null,
          session_log: input.sessionLogPath,
          raw_dir: input.rawDirPath,
          rounds: [],
        };
      }
      // Idempotent on retries: a re-submitted round replaces its entry instead
      // of duplicating it (client timeouts can replay a call). Replaying an OLD
      // round after newer ones is not a supported scenario: the targeted round
      // is replaced but later rounds are kept, which can leave the report
      // internally inconsistent - acceptable, the raw logs remain authoritative.
      state.rounds = state.rounds.filter((r) => r.round !== input.round.round);
      state.rounds.push(input.round);
      state.consensus = input.consensus;
      state.thread_id = input.threadId ?? state.thread_id;
      state.total_duration_seconds = input.totalDurationSeconds;
      state.total_usage = input.totalUsage;
      state.session_log = input.sessionLogPath;
      state.raw_dir = input.rawDirPath;
      saveState(state);
      writeReportFile(state);
      return { reportId: state.report_id, reportPath: state.report_path, reportError: null };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logStderr(`report generation failed for "${reportId}": ${message}`);
    return { reportId: null, reportPath: null, reportError: message };
  }
}

/**
 * Seals the reviser's plain-language summary into the report. The summary is
 * stored in the STATE, then the file is regenerated from it: a later
 * regeneration can never lose it. Idempotent: re-sealing overwrites (last
 * write wins). Throws ReportError on unknown/invalid report_id.
 */
export async function sealSummary(reportId: string, summary: string): Promise<{ reportPath: string }> {
  if (!REPORT_ID_PATTERN.test(reportId)) {
    throw new ReportError(`Invalid report_id: "${reportId}"`);
  }
  return withReportLock(reportId, () => {
    const state = loadState(reportId);
    if (state === null) {
      throw new ReportError(
        `Unknown report_id "${reportId}": no report state found. Use the report_id returned by clonst_review.`
      );
    }
    state.summary = summary;
    saveState(state);
    writeReportFile(state);
    return { reportPath: state.report_path };
  });
}
