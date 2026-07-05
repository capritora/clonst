import { test } from "node:test";
import assert from "node:assert/strict";
import { isConsensus, parseReviewerResponse } from "../core/consensus.js";

const VALID_RESPONSE = JSON.stringify({
  verdict: "APPROVED",
  score: 9,
  critique: "Solid.",
  required_changes: [],
  suggestions: ["clean up a comment"],
  risks_identified: [],
  _feedback: "",
});

test("valid JSON: every field extracted, no fallback", () => {
  const v = parseReviewerResponse(VALID_RESPONSE);
  assert.equal(v.verdict, "APPROVED");
  assert.equal(v.score, 9);
  assert.equal(v.critique, "Solid.");
  assert.deepEqual(v.suggestions, ["clean up a comment"]);
  assert.equal(v.feedback, null);
  assert.equal(v.parsed_from_fallback, false);
  assert.equal(v.raw_text, VALID_RESPONSE);
  assert.equal(isConsensus(v), true);
});

test("JSON inside markdown fences with surrounding text: still extracted", () => {
  const wrapped = "Here is my review:\n```json\n" + VALID_RESPONSE + "\n```\nDone.";
  const v = parseReviewerResponse(wrapped);
  assert.equal(v.verdict, "APPROVED");
  assert.equal(v.parsed_from_fallback, false);
});

test("lowercase verdict: normalized", () => {
  const v = parseReviewerResponse(JSON.stringify({ verdict: "approved", score: 8, required_changes: [] }));
  assert.equal(v.verdict, "APPROVED");
});

test("false-positive guard: 'not approved' in free text is NEVER APPROVED", () => {
  const v = parseReviewerResponse("The plan is not approved, too many issues. I cannot approve this.");
  assert.equal(v.verdict, "CHANGES_NEEDED");
  assert.equal(v.parsed_from_fallback, true);
});

test("broken JSON but verdict recoverable by anchored regex", () => {
  const broken = '{"verdict": "CHANGES_NEEDED", "score": 4, "critique": "missing a brace"';
  const v = parseReviewerResponse(broken);
  assert.equal(v.verdict, "CHANGES_NEEDED");
  assert.equal(v.parsed_from_fallback, true);
  assert.equal(v.raw_text, broken, "the raw text is always preserved");
});

test("broken JSON with an APPROVED verdict recoverable by anchored regex", () => {
  const broken = 'preamble {"verdict": "APPROVED", "score": 9, "critique": "ok"';
  const v = parseReviewerResponse(broken);
  assert.equal(v.verdict, "APPROVED");
  assert.equal(v.parsed_from_fallback, true);
});

test("response with no JSON and no verdict: conservative CHANGES_NEEDED", () => {
  const v = parseReviewerResponse("I cannot review this content.");
  assert.equal(v.verdict, "CHANGES_NEEDED");
  assert.equal(v.parsed_from_fallback, true);
  assert.equal(isConsensus(v), false);
});

test("verdict absent but score >= 8 with no required_changes: APPROVED deduced (marked as fallback)", () => {
  const v = parseReviewerResponse(JSON.stringify({ score: 8, critique: "good", required_changes: [] }));
  assert.equal(v.verdict, "APPROVED");
  assert.equal(v.parsed_from_fallback, true);
});

test("verdict absent, score >= 8 BUT non-empty required_changes: CHANGES_NEEDED", () => {
  const v = parseReviewerResponse(
    JSON.stringify({ score: 9, critique: "almost", required_changes: ["fix X"] })
  );
  assert.equal(v.verdict, "CHANGES_NEEDED");
});

test("unknown verdict ('MAYBE'): conservative CHANGES_NEEDED", () => {
  const v = parseReviewerResponse(JSON.stringify({ verdict: "MAYBE", score: 9, required_changes: [] }));
  assert.equal(v.verdict, "CHANGES_NEEDED");
  assert.equal(v.parsed_from_fallback, true);
});

test("fields with unexpected types: normalized without a crash (string, null, numbers in lists)", () => {
  const v = parseReviewerResponse(
    JSON.stringify({
      verdict: "CHANGES_NEEDED",
      score: "nine",
      critique: 42,
      required_changes: "a single change as a string",
      suggestions: null,
      risks_identified: [1, "valid risk", null],
      _feedback: "   ",
    })
  );
  assert.equal(v.verdict, "CHANGES_NEEDED");
  assert.equal(v.score, null);
  assert.equal(v.critique, "");
  assert.deepEqual(v.required_changes, ["a single change as a string"]);
  assert.deepEqual(v.suggestions, []);
  assert.deepEqual(v.risks_identified, ["valid risk"]);
  assert.equal(v.feedback, null);
});

test("out-of-bounds score: null", () => {
  assert.equal(parseReviewerResponse(JSON.stringify({ verdict: "APPROVED", score: 15 })).score, null);
  assert.equal(parseReviewerResponse(JSON.stringify({ verdict: "APPROVED", score: 0 })).score, null);
});

test("isConsensus: APPROVED with leftover required_changes = NO consensus (contradiction)", () => {
  const v = parseReviewerResponse(
    JSON.stringify({ verdict: "APPROVED", score: 8, required_changes: ["still fix Y"] })
  );
  assert.equal(v.verdict, "APPROVED");
  assert.equal(isConsensus(v), false);
});

test("broken JSON with APPROVED + visible but lost required_changes: NEVER consensus", () => {
  // Scenario found by an early adversarial review: the regex fallback recovers
  // APPROVED but the required_changes are unrecoverable. Consensus would declare
  // approved a content whose raw text visibly lists required changes.
  const broken = '{"verdict":"APPROVED","required_changes":["fix X"';
  const v = parseReviewerResponse(broken);
  assert.equal(v.verdict, "APPROVED");
  assert.equal(v.parsed_from_fallback, true);
  assert.equal(isConsensus(v), false, "a fallback APPROVED does not prove required_changes was empty");
});

test("verdict absent, score 9, required_changes of object type: CHANGES_NEEDED (no deduction on a lossy field)", () => {
  const v = parseReviewerResponse(
    JSON.stringify({ score: 9, critique: "good", required_changes: { "0": "fix X" } })
  );
  assert.equal(v.verdict, "CHANGES_NEEDED");
  assert.equal(v.parsed_from_fallback, true);
  assert.equal(isConsensus(v), false);
});

test("explicit APPROVED but required_changes of unexpected type: verdict kept, consensus refused", () => {
  const v = parseReviewerResponse(
    JSON.stringify({ verdict: "APPROVED", score: 9, required_changes: { "0": "fix X" } })
  );
  assert.equal(v.verdict, "APPROVED");
  assert.equal(v.parsed_from_fallback, true, "lossy normalization = information possibly lost");
  assert.equal(isConsensus(v), false);
});

test("APPROVED deduced from the score (verdict absent): APPROVED verdict but consensus refused (fallback)", () => {
  const v = parseReviewerResponse(JSON.stringify({ score: 8, critique: "good", required_changes: [] }));
  assert.equal(v.verdict, "APPROVED");
  assert.equal(isConsensus(v), false, "every fallback APPROVED is excluded from consensus");
});

test("multiple JSON objects with CONTRADICTORY verdicts: CHANGES_NEEDED forced", () => {
  const multi =
    '{"verdict":"APPROVED","score":9,"critique":"v1"}\n' +
    '{"verdict":"CHANGES_NEEDED","score":4,"critique":"v2"}';
  const v = parseReviewerResponse(multi);
  assert.equal(v.verdict, "CHANGES_NEEDED", "disagreeing verdicts: none is trustworthy");
  assert.equal(v.parsed_from_fallback, true);
  assert.equal(isConsensus(v), false);
});

test("multiple JSON objects with UNANIMOUS verdicts: common verdict kept, never consensus", () => {
  const multi =
    '{"verdict":"APPROVED","score":9,"critique":"v1"}\n' +
    '{"verdict":"APPROVED","score":8,"critique":"v2"}';
  const v = parseReviewerResponse(multi);
  assert.equal(v.verdict, "APPROVED");
  assert.equal(v.parsed_from_fallback, true);
  assert.equal(isConsensus(v), false, "a fallback verdict stays excluded from consensus");
});

test("non-empty _feedback: surfaced", () => {
  const v = parseReviewerResponse(
    JSON.stringify({ verdict: "CHANGES_NEEDED", _feedback: "the project context was missing" })
  );
  assert.equal(v.feedback, "the project context was missing");
});

test("markdown fences INSIDE a JSON string value: content preserved (no global replace)", () => {
  // Regression (2026-07-04 audit): the old global fence replace corrupted the
  // ``` quoted in the reviewer's critique (e.g. a code excerpt). Only the fences
  // at the ends of the response are stripped.
  const critique = "The code quotes ```ts\nfoo()\n``` without closing it.";
  const raw =
    "```json\n" +
    JSON.stringify({ verdict: "CHANGES_NEEDED", critique, required_changes: ["fix the fence"] }) +
    "\n```";
  const v = parseReviewerResponse(raw);
  assert.equal(v.verdict, "CHANGES_NEEDED");
  assert.equal(v.critique, critique, "quoted backticks must survive parsing");
  assert.deepEqual(v.required_changes, ["fix the fence"]);
  assert.equal(v.parsed_from_fallback, false);
});

test("explicit required_changes: null = same treatment as absent (empty, no fallback)", () => {
  // Regression (2026-07-04 audit, bug catalog 1.4): null took a silent path
  // distinct from undefined. Same behavior, now logged the same way.
  const v = parseReviewerResponse(JSON.stringify({ verdict: "APPROVED", required_changes: null }));
  assert.equal(v.verdict, "APPROVED");
  assert.deepEqual(v.required_changes, []);
  assert.equal(v.parsed_from_fallback, false);
  assert.equal(isConsensus(v), true);
});
