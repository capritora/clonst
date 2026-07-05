import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLogger, sanitizeName } from "../utils/logger.js";
import { logsDir } from "../utils/paths.js";

beforeEach(() => {
  process.env.CLONST_HOME = mkdtempSync(path.join(os.tmpdir(), "clonst-test-"));
});

test("sanitizeName neutralizes path traversal and separators", () => {
  assert.equal(sanitizeName("round_1.jsonl"), "round_1.jsonl");
  assert.equal(sanitizeName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(sanitizeName("..\\..\\evil"), ".._.._evil");
  assert.equal(sanitizeName(".."), "_");
  assert.equal(sanitizeName("."), "_");
  assert.equal(sanitizeName(""), "_");
  assert.equal(sanitizeName("a b/c"), "a_b_c");
});

test("SessionLogger rejects a non-conforming sessionId (internal bug, fails early)", () => {
  for (const bad of ["../evil", "a/b", "a\\b", "..", "", "a b"]) {
    assert.throws(() => new SessionLogger(bad), /Invalid sessionId/);
  }
});

test("SessionLogger writes the timestamped JSONL and the raw response in the right directory", () => {
  const logger = new SessionLogger("session-test-1");
  logger.log({ round: 1, actor: "codex" });

  const jsonl = readFileSync(path.join(logsDir(), "session-test-1.jsonl"), "utf-8").trim();
  const entry = JSON.parse(jsonl);
  assert.equal(entry.round, 1);
  assert.equal(entry.actor, "codex");
  assert.ok(entry.timestamp);

  const rawPath = logger.saveRaw("round_1_stdout.jsonl", "raw content");
  assert.ok(rawPath !== null);
  assert.equal(readFileSync(rawPath, "utf-8"), "raw content");
  assert.ok(rawPath.startsWith(path.join(logsDir(), "raw", "session-test-1")));
});

test("SessionLogger.saveRaw sanitizes the name instead of losing the content", () => {
  const logger = new SessionLogger("session-test-2");
  const rawPath = logger.saveRaw("../../outside/the/directory.txt", "paid response");
  assert.ok(rawPath !== null);
  // The file stays confined to the session's raw directory
  assert.ok(rawPath.startsWith(path.join(logsDir(), "raw", "session-test-2")));
  assert.ok(existsSync(rawPath));
  assert.equal(readFileSync(rawPath, "utf-8"), "paid response");
});
