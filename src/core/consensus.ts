import { logStderr } from "../utils/logger.js";

export type Verdict = "APPROVED" | "CHANGES_NEEDED";

export interface ReviewerVerdict {
  verdict: Verdict;
  /** 1-10 score announced by the reviewer, null if absent or invalid. */
  score: number | null;
  critique: string;
  required_changes: string[];
  suggestions: string[];
  risks_identified: string[];
  /** Reviewer feedback about the prompt itself (_feedback field). */
  feedback: string | null;
  /**
   * true if the JSON could not be parsed and the verdict comes from the
   * fallback (anchored regex) or the conservative default. The caller must know.
   */
  parsed_from_fallback: boolean;
  /** The reviewer's complete raw response, always preserved. */
  raw_text: string;
}

/**
 * Normalizes an LLM field that may be a string, a list, null or absent
 * (bug catalog rule: never assume the type).
 * `lossy` = true when normalization may have LOST information (unexpected type,
 * or non-string items filtered out of a list): the field cannot be considered
 * provably empty/complete.
 */
function normalizeStringArray(value: unknown): { list: string[]; lossy: boolean } {
  if (value === null || value === undefined) return { list: [], lossy: false };
  if (typeof value === "string") return { list: value.trim() ? [value] : [], lossy: false };
  if (Array.isArray(value)) {
    const list = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    return { list, lossy: list.length !== value.length };
  }
  // Object, number, boolean...: content present but unrecoverable.
  return { list: [], lossy: true };
}

function normalizeScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1 || value > 10) return null;
  return value;
}

/**
 * Extracts the first plausible JSON object from a text: strips optional
 * markdown fences then takes from the first opening brace to the last
 * closing one.
 */
function extractJsonCandidate(text: string): string | null {
  // Fences are stripped ONLY at the ends of the response: a global replace
  // would corrupt ``` appearing INSIDE JSON string values (e.g. a critique
  // quoting code). Brace-based extraction ignores inner fences anyway (they
  // contain no braces).
  const withoutFences = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return withoutFences.slice(start, end + 1);
}

/**
 * Fallback when the JSON is unusable: ANCHORED regex on the verdict field.
 * Never includes("approved"): "not approved" or a critique quoting the word
 * would produce a false positive.
 * If several occurrences CONTRADICT each other (multi-object response), none is
 * trustworthy: CHANGES_NEEDED forced. Unanimous: the common verdict is kept
 * (marked as fallback, so excluded from consensus anyway).
 */
const VERDICT_FALLBACK_REGEX = /"verdict"\s*:\s*"(APPROVED|CHANGES_NEEDED)"/gi;

function verdictFromFallbackRegex(text: string): Verdict | null {
  const found = new Set<string>();
  for (const match of text.matchAll(VERDICT_FALLBACK_REGEX)) {
    found.add(match[1].toUpperCase());
  }
  if (found.size === 0) return null;
  if (found.size > 1) {
    logStderr("consensus: contradictory verdicts in the response, CHANGES_NEEDED forced");
    return "CHANGES_NEEDED";
  }
  return [...found][0] as Verdict;
}

/**
 * Parses the reviewer's response into a structured verdict.
 *
 * Verdict resolution order:
 * 1. Explicit `verdict` field of the JSON (normalized to uppercase).
 * 2. If absent: score >= 8 AND no required_change -> APPROVED (plan rule).
 * 3. If the JSON is unusable: anchored regex over the raw text.
 * 4. Conservative default: CHANGES_NEEDED (never approve by accident).
 */
export function parseReviewerResponse(rawText: string): ReviewerVerdict {
  const conservative = (critique: string): ReviewerVerdict => ({
    verdict: "CHANGES_NEEDED",
    score: null,
    critique,
    required_changes: [],
    suggestions: [],
    risks_identified: [],
    feedback: null,
    parsed_from_fallback: true,
    raw_text: rawText,
  });

  const candidate = extractJsonCandidate(rawText);
  let parsed: Record<string, unknown> | null = null;
  if (candidate !== null) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }

  if (parsed === null) {
    // Unusable JSON: anchored regex fallback over the raw text, else conservative.
    const fallbackVerdict = verdictFromFallbackRegex(rawText);
    if (fallbackVerdict !== null) {
      logStderr("consensus: unusable reviewer JSON, verdict recovered by anchored regex");
      return { ...conservative(rawText), verdict: fallbackVerdict };
    }
    logStderr("consensus: reviewer response with no JSON and no detectable verdict, conservative CHANGES_NEEDED");
    return conservative(rawText);
  }

  const score = normalizeScore(parsed.score);
  if (parsed.required_changes === undefined || parsed.required_changes === null) {
    // Non-conforming to the requested format but semantically clear: observability
    // only, no lossy marking (decision from the step 4 review round 2).
    // An explicit null gets the same treatment as absence (bug catalog rule 1.4:
    // never let null take a different silent path than absence).
    logStderr("consensus: required_changes absent or null in the JSON (the requested format requires [] when empty)");
  }
  const requiredChanges = normalizeStringArray(parsed.required_changes);
  if (requiredChanges.lossy) {
    logStderr("consensus: required_changes of unexpected type, information possibly lost (marked as fallback)");
  }

  let verdict: Verdict;
  let fromFallback = requiredChanges.lossy;
  const verdictAbsent = parsed.verdict === undefined || parsed.verdict === null;
  const rawVerdict = typeof parsed.verdict === "string" ? parsed.verdict.trim().toUpperCase() : null;
  if (rawVerdict === "APPROVED" || rawVerdict === "CHANGES_NEEDED") {
    verdict = rawVerdict;
  } else if (
    verdictAbsent &&
    score !== null &&
    score >= 8 &&
    requiredChanges.list.length === 0 &&
    !requiredChanges.lossy
  ) {
    // Score deduction is only allowed when the verdict is ABSENT and
    // required_changes is PROVABLY empty (not merely emptied by a lossy
    // normalization). An explicit but unknown verdict ("MAYBE") is an
    // ambiguity: never deduced.
    logStderr(`consensus: verdict absent, APPROVED deduced from score ${score} with no required_changes`);
    verdict = "APPROVED";
    fromFallback = true;
  } else {
    if (!verdictAbsent && rawVerdict !== "APPROVED" && rawVerdict !== "CHANGES_NEEDED") {
      logStderr(`consensus: unusable verdict (${JSON.stringify(parsed.verdict)}), conservative CHANGES_NEEDED`);
    }
    verdict = "CHANGES_NEEDED";
    fromFallback = true;
  }

  return {
    verdict,
    score,
    critique: typeof parsed.critique === "string" ? parsed.critique : "",
    required_changes: requiredChanges.list,
    suggestions: normalizeStringArray(parsed.suggestions).list,
    risks_identified: normalizeStringArray(parsed.risks_identified).list,
    feedback: typeof parsed._feedback === "string" && parsed._feedback.trim() ? parsed._feedback : null,
    parsed_from_fallback: fromFallback,
    raw_text: rawText,
  };
}

/**
 * Consensus is reached only on a PROVEN APPROVED:
 * - explicit APPROVED verdict from clean JSON (never from a fallback: an
 *   APPROVED recovered by regex or deduced from a score does not prove that
 *   required_changes was actually empty - it may have been lost by parsing);
 * - AND zero remaining required_changes (a reviewer that approves while listing
 *   required changes contradicts itself).
 */
export function isConsensus(verdict: ReviewerVerdict): boolean {
  return (
    verdict.verdict === "APPROVED" &&
    verdict.required_changes.length === 0 &&
    !verdict.parsed_from_fallback
  );
}
