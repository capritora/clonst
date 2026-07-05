import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeArg, cleanEnv, quoteArg, spawnCLI } from "../utils/process.js";

// dist/tests/ -> project root (the .mjs fixtures are not compiled, they live in scripts/)
// Paths are passed RAW to spawnCLI: quoting is its responsibility.
const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const fixture = (name: string) => path.join(projectRoot, "scripts", "fixtures", name);

const isWindows = process.platform === "win32";

test("cleanEnv strips the Claude Code session variables and keeps the rest", () => {
  const env = cleanEnv({
    PATH: "/usr/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CODEX_HOME: "keep",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CODEX_HOME, "keep");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
});

test("cleanEnv is case-insensitive (Windows environment variable names are)", () => {
  const env = cleanEnv({
    ClaudeCode: "1",
    claude_code_entrypoint: "cli",
    NOT_CLAUDE: "keep",
  });
  assert.equal(env.ClaudeCode, undefined);
  assert.equal(env.claude_code_entrypoint, undefined);
  assert.equal(env.NOT_CLAUDE, "keep");
});

test("assertSafeArg accepts a UUID and rejects shell metacharacters", () => {
  const uuid = "019f2d71-02e2-7ae1-911d-30452a0f901e";
  assert.equal(assertSafeArg(uuid, "thread_id"), uuid);
  for (const bad of ["a b", "a;b", "a|b", "a&&b", "$(x)", "`x`", '"quoted"', ""]) {
    assert.throws(() => assertSafeArg(bad, "thread_id"), /Unsafe/);
  }
});

test("quoteArg leaves simple arguments untouched (flags, paths without spaces)", () => {
  // Backslash paths are only "simple" on Windows: the POSIX whitelist excludes
  // the backslash, so such an argument is legitimately quoted there.
  const args = ["--json", "-", "codex", "a/b/c.json", "key=value"];
  if (isWindows) args.push("C:\\Users\\alice\\file.txt");
  for (const arg of args) {
    assert.equal(quoteArg(arg), arg);
  }
});

test("quoteArg (Windows) rejects characters without a reliable cmd escape", { skip: !isWindows }, () => {
  for (const bad of ['a"b', "100%", "line1\nline2", "carriage\rreturn"]) {
    assert.throws(() => quoteArg(bad), /cannot be safely represented/);
  }
});

test("spawnCLI passes arguments with spaces and metacharacters through intact (centralized quoting)", async () => {
  const args = [
    "hello world",
    "C:\\dir with space\\out.txt",
    "a&b",
    "semi;colon",
    "(parens)",
    "pipe|pipe",
    "<angle>",
    "single'quote",
  ];
  const result = await spawnCLI("node", [fixture("print-args.mjs"), ...args], {
    timeoutMs: 15_000,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("spawnCLI passes an argument with trailing backslashes through intact (msvcrt rule)", async () => {
  const args = ["C:\\dir with space\\"];
  const result = await spawnCLI("node", [fixture("print-args.mjs"), ...args], {
    timeoutMs: 15_000,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("spawnCLI sends the prompt through stdin and captures stdout", async () => {
  const result = await spawnCLI("node", [fixture("echo-stdin.mjs")], {
    stdin: "hello clonst",
    timeoutMs: 15_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "ECHO:hello clonst");
  assert.ok(result.durationMs >= 0);
});

test("spawnCLI kills the process tree on timeout and reports it", async () => {
  const result = await spawnCLI("node", [fixture("sleep.mjs")], {
    timeoutMs: 1_000,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("spawnCLI rejects a command that is not a simple executable name", async () => {
  for (const bad of ["C:\\Program Files\\codex.exe", "./codex", "a b", "node --version", "dir/cmd"]) {
    assert.throws(() => spawnCLI(bad, []), /simple executable name/);
  }
});

test("spawnCLI: real-world --output-last-message to a path with spaces (Codex contract)", async () => {
  // Reproduces the call the provider will make: a dynamic file path under
  // ~/.clonst/ (whose home may contain spaces) passed after a flag.
  const spacedDir = mkdtempSync(path.join(os.tmpdir(), "clonst home spaced-"));
  const target = path.join(spacedDir, "last message.txt");
  const result = await spawnCLI(
    "node",
    [fixture("write-last-message.mjs"), "--output-last-message", target],
    { timeoutMs: 15_000 }
  );
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert.equal(readFileSync(target, "utf-8"), "last agent message");
});

test("spawnCLI handles a failing process (non-zero exit code)", async () => {
  const result = await spawnCLI("node", ["-e", "process.exit(3)"], {
    timeoutMs: 15_000,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});
