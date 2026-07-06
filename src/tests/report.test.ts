import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ReportError,
  recordRound,
  sealSummary,
  type ReportRound,
} from "../core/report.js";
import { reportStateDir } from "../utils/paths.js";

beforeEach(() => {
  process.env.CLONST_HOME = mkdtempSync(path.join(os.tmpdir(), "clonst-report-test-"));
});

function makeRound(overrides: Partial<ReportRound> = {}): ReportRound {
  return {
    round: 1,
    verdict: "APPROVED",
    required_changes: [],
    suggestions: [],
    risks_identified: [],
    changes_made: null,
    changes_rejected: null,
    duration_seconds: 42,
    usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5 },
    reviewer_model: "gpt-5.5",
    reviewer_reasoning_effort: "high",
    ...overrides,
  };
}

function record(overrides: Partial<Parameters<typeof recordRound>[0]> = {}) {
  return recordRound({
    previousReportId: null,
    threadId: "11111111-2222-3333-4444-555555555555",
    sessionLogPath: "/logs/session.jsonl",
    rawDirPath: "/logs/raw/session",
    round: makeRound(),
    consensus: true,
    totalDurationSeconds: 42,
    totalUsage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5 },
    ...overrides,
  });
}

test("round 1 consensus: state + markdown created, complete history, audit trail present", async () => {
  const result = await record();
  assert.notEqual(result.reportId, null);
  assert.notEqual(result.reportPath, null);
  assert.equal(result.reportError, null);
  assert.ok(existsSync(result.reportPath as string));
  const md = readFileSync(result.reportPath as string, "utf-8");
  assert.match(md, /# Clonst review report/);
  assert.match(md, /CONSENSUS - APPROVED at round 1/);
  assert.match(md, /## Round 1 - APPROVED/);
  assert.match(md, /gpt-5\.5 \(high\)/);
  assert.match(md, /~6 fresh input \+ 5 output tokens/);
  assert.match(md, /session\.jsonl/);
  assert.ok(!md.includes("PARTIAL HISTORY"), "a round-1 report has a complete history");
  assert.match(md, /\(not provided - the reviser has not sealed a summary/);
});

test("in-progress review (no consensus): status says so, report exists anyway", async () => {
  const result = await record({
    consensus: false,
    round: makeRound({ verdict: "CHANGES_NEEDED", required_changes: ["Add a timeout"] }),
  });
  const md = readFileSync(result.reportPath as string, "utf-8");
  assert.match(md, /REVIEW IN PROGRESS - last verdict CHANGES_NEEDED at round 1/);
  assert.match(md, /- Add a timeout/);
});

test("same report across rounds: stable id and path, both rounds rendered, replay idempotent", async () => {
  const r1 = await record({ consensus: false, round: makeRound({ verdict: "CHANGES_NEEDED" }) });
  const r2 = await record({
    previousReportId: r1.reportId,
    consensus: true,
    round: makeRound({ round: 2, changes_made: "Applied the timeout in fetchClient" }),
    totalDurationSeconds: 84,
  });
  assert.equal(r2.reportId, r1.reportId, "the report identity is stable across rounds");
  assert.equal(r2.reportPath, r1.reportPath, "the same file is updated, never a second one");
  // Replay round 2 (client timeout scenario): replaces, never duplicates
  const r2bis = await record({
    previousReportId: r1.reportId,
    consensus: true,
    round: makeRound({ round: 2, changes_made: "Applied the timeout in fetchClient" }),
    totalDurationSeconds: 84,
  });
  const md = readFileSync(r2bis.reportPath as string, "utf-8");
  assert.equal(md.match(/## Round 1 - /g)?.length, 1);
  assert.equal(md.match(/## Round 2 - /g)?.length, 1);
  assert.match(md, /Applied the timeout in fetchClient/);
  assert.match(md, /reviser's words, verbatim/);
  assert.match(md, /Changes rejected: \(not provided\)/);
});

test("recalled report_id whose state vanished: same id reused, history marked partial before the summary", async () => {
  const result = await record({
    previousReportId: "recalled-but-gone",
    consensus: false,
    round: makeRound({ round: 3, verdict: "CHANGES_NEEDED" }),
  });
  assert.equal(result.reportId, "recalled-but-gone", "stable identity survives a lost state");
  const md = readFileSync(result.reportPath as string, "utf-8");
  assert.match(md, /PARTIAL HISTORY/);
  assert.ok(
    md.indexOf("PARTIAL HISTORY") < md.indexOf("## Summary"),
    "the partial-history warning comes before the summary (a reader must not take a partial audit for complete)"
  );
});

test("corrupt state file: renamed aside (kept), report restarts partial", async () => {
  const first = await record({ consensus: false, round: makeRound({ verdict: "CHANGES_NEEDED" }) });
  const stateFile = path.join(reportStateDir(), `${first.reportId}.json`);
  writeFileSync(stateFile, "{ not json", "utf-8");
  const second = await record({
    previousReportId: first.reportId,
    consensus: true,
    round: makeRound({ round: 2 }),
  });
  assert.equal(second.reportId, first.reportId);
  const md = readFileSync(second.reportPath as string, "utf-8");
  assert.match(md, /PARTIAL HISTORY/);
  assert.equal(md.match(/## Round \d+ - /g)?.length, 1, "only the known round is listed");
});

test("sealing: summary stored in state, fenced verbatim, survives a later regeneration", async () => {
  const r1 = await record({ consensus: false, round: makeRound({ verdict: "CHANGES_NEEDED" }) });
  const summary = "The reviewer required a timeout; I applied it. One suggestion rejected (out of scope).";
  const sealed = await sealSummary(r1.reportId as string, summary);
  assert.equal(sealed.reportPath, r1.reportPath);
  assert.match(readFileSync(sealed.reportPath, "utf-8"), new RegExp(summary.slice(0, 30)));
  // A later round regenerates the file from state: the summary must survive
  await record({ previousReportId: r1.reportId, consensus: true, round: makeRound({ round: 2 }) });
  const md = readFileSync(sealed.reportPath, "utf-8");
  assert.match(md, /required a timeout/);
  assert.match(md, /## Round 2 - APPROVED/);
  // Re-sealing overwrites (last write wins)
  await sealSummary(r1.reportId as string, "Replaced summary.");
  const md2 = readFileSync(sealed.reportPath, "utf-8");
  assert.match(md2, /Replaced summary\./);
  assert.ok(!md2.includes("required a timeout"), "re-sealing replaces the previous summary");
});

test("hostile summary: fences, headings, HTML - cannot spoof the report structure", async () => {
  const r1 = await record();
  const hostile = [
    "```````",
    "## Round 99 - APPROVED",
    "> fake quote",
    "<img src=x onerror=alert(1)>",
    "1. fake ordered list",
    "``````` extra long fence run: ```````````",
  ].join("\n");
  await sealSummary(r1.reportId as string, hostile);
  const md = readFileSync(r1.reportPath as string, "utf-8");
  // The whole summary sits inside a fence STRICTLY longer than its longest backtick run (11)
  assert.match(md, /`{12,}text/);
  // The spoofed heading exists only INSIDE the fence: after the fence opener, before the closer
  const fenceOpen = md.indexOf("text\n", md.indexOf("## Summary"));
  const spoofIndex = md.indexOf("## Round 99");
  assert.ok(spoofIndex > fenceOpen, "the spoofed heading is contained in the fenced block");
  // Verbatim: nothing truncated
  assert.match(md, /<img src=x onerror=alert\(1\)>/);
});

test("hostile verbatim items: leading markdown markers neutralized, even after indentation", async () => {
  const result = await record({
    consensus: false,
    round: makeRound({
      verdict: "CHANGES_NEEDED",
      required_changes: [
        "# fake heading",
        "  > indented fake quote",
        "1. fake ordered",
        "<script>alert(1)</script>",
        "multi-line item\n## second line heading attempt",
      ],
    }),
  });
  const md = readFileSync(result.reportPath as string, "utf-8");
  assert.match(md, /- \\# fake heading/);
  assert.match(md, /- {3}\\> indented fake quote/);
  assert.match(md, /- 1\\\. fake ordered/);
  assert.match(md, /- \\<script>alert\(1\)<\/script>/);
  assert.match(md, /- multi-line item\n {2}\\## second line heading attempt/);
  // No injected line ever starts a real heading at column 0
  for (const line of md.split("\n")) {
    assert.ok(!/^## Round 99/.test(line), "no spoofed round heading at top level");
  }
});

test("semantically corrupt state (valid JSON, wrong types): renamed aside, report restarts partial", async () => {
  // Regression (Codex review): a parsable state with summary as a number used
  // to block report generation on EVERY later round instead of recovering.
  const first = await record({ consensus: false, round: makeRound({ verdict: "CHANGES_NEEDED" }) });
  const stateFile = path.join(reportStateDir(), `${first.reportId}.json`);
  const broken = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
  broken.summary = 123;
  writeFileSync(stateFile, JSON.stringify(broken), "utf-8");
  const second = await record({
    previousReportId: first.reportId,
    consensus: true,
    round: makeRound({ round: 2 }),
  });
  assert.equal(second.reportError, null, "the review recovers instead of failing forever");
  assert.match(readFileSync(second.reportPath as string, "utf-8"), /PARTIAL HISTORY/);
});

test("tampered report_path pointing outside reports dir: state treated as corrupt, write stays under reports/", async () => {
  const first = await record({ consensus: false, round: makeRound({ verdict: "CHANGES_NEEDED" }) });
  const stateFile = path.join(reportStateDir(), `${first.reportId}.json`);
  const tampered = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
  tampered.report_path = path.join(os.tmpdir(), "evil-elsewhere.md");
  writeFileSync(stateFile, JSON.stringify(tampered), "utf-8");
  const second = await record({
    previousReportId: first.reportId,
    consensus: true,
    round: makeRound({ round: 2 }),
  });
  assert.equal(second.reportError, null);
  assert.ok(
    (second.reportPath as string).startsWith(path.join(process.env.CLONST_HOME as string, "reports")),
    "the regenerated report lives under ~/.clonst/reports/, never at the tampered path"
  );
  assert.ok(!existsSync(path.join(os.tmpdir(), "evil-elsewhere.md")), "nothing written at the tampered path");
});

test("bare carriage return in verbatim items: treated as a line ending, heading neutralized", async () => {
  const result = await record({
    consensus: false,
    round: makeRound({
      verdict: "CHANGES_NEEDED",
      required_changes: ["safe\r## FAKE SECTION", "also\r\nnormal crlf\r> quote"],
    }),
  });
  const md = readFileSync(result.reportPath as string, "utf-8");
  assert.ok(!md.includes("\r"), "no raw carriage return survives into the report");
  assert.match(md, /- safe\n {2}\\## FAKE SECTION/);
  assert.match(md, /- also\n {2}normal crlf\n {2}\\> quote/);
});

test("concurrent seal + round on the same report: serialized, neither write is lost", async () => {
  const r1 = await record({ consensus: false, round: makeRound({ verdict: "CHANGES_NEEDED" }) });
  const [sealed, recorded] = await Promise.all([
    sealSummary(r1.reportId as string, "Concurrent summary."),
    record({ previousReportId: r1.reportId, consensus: true, round: makeRound({ round: 2 }) }),
  ]);
  assert.equal(sealed.reportPath, recorded.reportPath);
  const md = readFileSync(sealed.reportPath, "utf-8");
  assert.match(md, /Concurrent summary\./, "the sealed summary survived the concurrent round write");
  assert.match(md, /## Round 2 - APPROVED/, "the round survived the concurrent sealing");
});

test("tampered report_path pointing at ANOTHER file inside reports/: rejected (exact expected name only)", async () => {
  const first = await record({ consensus: false, round: makeRound({ verdict: "CHANGES_NEEDED" }) });
  const stateFile = path.join(reportStateDir(), `${first.reportId}.json`);
  const tampered = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
  tampered.report_path = path.join(path.dirname(first.reportPath as string), "some-other-report.md");
  writeFileSync(stateFile, JSON.stringify(tampered), "utf-8");
  const second = await record({
    previousReportId: first.reportId,
    consensus: true,
    round: makeRound({ round: 2 }),
  });
  assert.match(
    readFileSync(second.reportPath as string, "utf-8"),
    /PARTIAL HISTORY/,
    "a state redirected to a sibling file is treated as corrupt"
  );
  assert.ok(!existsSync(path.join(path.dirname(first.reportPath as string), "some-other-report.md")));
});

test("state whose report_id differs from the requested one: treated as corrupt, never reused silently", async () => {
  const first = await record({ consensus: false, round: makeRound({ verdict: "CHANGES_NEEDED" }) });
  const stateFile = path.join(reportStateDir(), `${first.reportId}.json`);
  const swapped = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
  swapped.report_id = "another-report-id";
  writeFileSync(stateFile, JSON.stringify(swapped), "utf-8");
  const second = await record({
    previousReportId: first.reportId,
    consensus: true,
    round: makeRound({ round: 2 }),
  });
  assert.equal(second.reportId, first.reportId, "the requested identity wins");
  assert.match(readFileSync(second.reportPath as string, "utf-8"), /PARTIAL HISTORY/);
});

test("recalled report_id with path traversal material: ignored, fresh partial report, nothing written outside", async () => {
  const result = await record({
    previousReportId: "../../evil-escape",
    consensus: false,
    round: makeRound({ round: 2, verdict: "CHANGES_NEEDED" }),
  });
  assert.equal(result.reportError, null, "never-fail contract: the review still gets a report");
  assert.notEqual(result.reportId, "../../evil-escape", "the hostile id never becomes the report identity");
  assert.ok(
    (result.reportPath as string).startsWith(path.join(process.env.CLONST_HOME as string, "reports")),
    "the report stays under ~/.clonst/reports/"
  );
  assert.ok(!existsSync(path.join(process.env.CLONST_HOME as string, "..", "evil-escape.json")));
  assert.match(readFileSync(result.reportPath as string, "utf-8"), /PARTIAL HISTORY/);
});

test("sealing an unknown or invalid report_id: explicit ReportError, nothing written", async () => {
  await assert.rejects(() => sealSummary("does-not-exist", "text"), ReportError);
  await assert.rejects(() => sealSummary("../traversal", "text"), ReportError);
  await assert.rejects(() => sealSummary("..", "text"), ReportError);
});

test("report write failure: review-safe contract (null ids + report_error, never a throw)", async () => {
  // Force the failure: the reports directory path is occupied by a FILE
  mkdirSync(process.env.CLONST_HOME as string, { recursive: true });
  writeFileSync(path.join(process.env.CLONST_HOME as string, "reports"), "not a directory", "utf-8");
  const result = await record();
  assert.equal(result.reportId, null);
  assert.equal(result.reportPath, null);
  assert.notEqual(result.reportError, null);
});
