import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProvider, parseCodexEvents, readCodexDefaults } from "../providers/codex.js";
import { ProviderError } from "../providers/base.js";
import { SessionLogger } from "../utils/logger.js";
import { logsDir } from "../utils/paths.js";

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const fixture = (name: string) => path.join(projectRoot, "scripts", "fixtures", name);
const fakeCodex = (name: string) => new CodexProvider({ command: "node", prefixArgs: [fixture(name)] });

beforeEach(() => {
  process.env.CLONST_HOME = mkdtempSync(path.join(os.tmpdir(), "clonst-test-"));
  // Isolates readCodexDefaults from the machine's real codex config (hermeticity)
  process.env.CODEX_HOME = mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
});

// --- parseCodexEvents: real JSONL contract pinned by the step 1 probes ---

const REAL_PROBE_JSONL = [
  '{"type":"thread.started","thread_id":"019f2d71-02e2-7ae1-911d-30452a0f901e"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"verdict\\": \\"APPROVED\\"}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":12049,"cached_input_tokens":9600,"output_tokens":94,"reasoning_output_tokens":44}}',
].join("\n");

test("parseCodexEvents extracts thread_id, agent message and usage from the real JSONL", () => {
  const events = parseCodexEvents(REAL_PROBE_JSONL);
  assert.equal(events.threadId, "019f2d71-02e2-7ae1-911d-30452a0f901e");
  assert.deepEqual(events.agentMessages, ['{"verdict": "APPROVED"}']);
  assert.equal(events.usage?.input_tokens, 12049);
  assert.equal(events.usage?.reasoning_output_tokens, 44);
  assert.equal(events.malformedLines, 0);
});

test("parseCodexEvents counts malformed lines without crashing or swallowing them", () => {
  const events = parseCodexEvents(REAL_PROBE_JSONL + "\nnot json\n42\n");
  assert.equal(events.threadId, "019f2d71-02e2-7ae1-911d-30452a0f901e");
  assert.equal(events.malformedLines, 2);
});

test("parseCodexEvents also counts known events with unexpected structure", () => {
  const events = parseCodexEvents(
    [
      '{"type":"thread.started"}',
      '{"type":"thread.started","thread_id":42}',
      '{"type":"item.completed","item":{"type":"agent_message","text":123}}',
      '{"type":"turn.completed"}',
      '{"type":"item.completed","item":{"type":"reasoning"}}',
    ].join("\n")
  );
  assert.equal(events.threadId, null);
  assert.deepEqual(events.agentMessages, []);
  // 4 anomalies: the two invalid thread.started, the agent_message without a
  // string text, the turn.completed without usage. The reasoning item is
  // legitimate, not counted.
  assert.equal(events.malformedLines, 4);
});

test("parseCodexEvents on an empty stream: nothing found, zero crash", () => {
  const events = parseCodexEvents("");
  assert.equal(events.threadId, null);
  assert.deepEqual(events.agentMessages, []);
  assert.equal(events.usage, null);
});

// --- CodexProvider.buildArgs: new session vs resume ---

test("buildArgs new session: exec - with read-only sandbox", () => {
  const provider = new CodexProvider();
  const args = provider.buildArgs(undefined, "C:\\out\\last.txt");
  assert.deepEqual(args, [
    "exec", "-", "--sandbox", "read-only",
    "--json", "--skip-git-repo-check", "--output-last-message", "C:\\out\\last.txt",
  ]);
});

test("buildArgs resume: exec resume <thread_id> without --sandbox (rejected by resume)", () => {
  const provider = new CodexProvider();
  const threadId = "019f2d71-02e2-7ae1-911d-30452a0f901e";
  const args = provider.buildArgs(threadId, "out.txt");
  assert.deepEqual(args, [
    "exec", "resume", threadId, "-",
    "--json", "--skip-git-repo-check", "--output-last-message", "out.txt",
  ]);
  assert.ok(!args.includes("--sandbox"));
});

test("buildArgs rejects a hostile thread_id (metacharacters)", () => {
  const provider = new CodexProvider();
  assert.throws(() => provider.buildArgs("id; rm -rf", "out.txt"), /Unsafe/);
});

test("buildArgs with model/effort overrides: ROOT -c before the subcommand, exec AND resume", () => {
  const provider = new CodexProvider();
  const overrides = { model: "gpt-5.5", reasoningEffort: "high" };
  assert.deepEqual(provider.buildArgs(undefined, "out.txt", overrides), [
    "-c", "model=gpt-5.5", "-c", "model_reasoning_effort=high",
    "exec", "-", "--sandbox", "read-only",
    "--json", "--skip-git-repo-check", "--output-last-message", "out.txt",
  ]);
  const threadId = "019f2d71-02e2-7ae1-911d-30452a0f901e";
  assert.deepEqual(provider.buildArgs(threadId, "out.txt", overrides), [
    "-c", "model=gpt-5.5", "-c", "model_reasoning_effort=high",
    "exec", "resume", threadId, "-",
    "--json", "--skip-git-repo-check", "--output-last-message", "out.txt",
  ]);
  // Without overrides: no -c, historical behavior intact
  assert.ok(!provider.buildArgs(undefined, "out.txt").includes("-c"));
  // Hostile override: rejected by the whitelist before any spawn
  assert.throws(() => provider.buildArgs(undefined, "out.txt", { model: "gpt 5; echo x" }), /Unsafe/);
});

// --- readCodexDefaults: best-effort model/effort resolution for display ---

test("readCodexDefaults reads the ROOT keys of config.toml and ignores [profiles.x] tables", () => {
  writeFileSync(
    path.join(process.env.CODEX_HOME as string, "config.toml"),
    [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "xhigh"',
      "",
      "[profiles.review]",
      'model = "decoy-must-not-be-read"',
      'model_reasoning_effort = "low"',
    ].join("\n"),
    "utf-8"
  );
  const defaults = readCodexDefaults();
  assert.equal(defaults.model, "gpt-5.5");
  assert.equal(defaults.reasoningEffort, "xhigh");
});

test("readCodexDefaults without config.toml: null (unknown), never a crash", () => {
  const defaults = readCodexDefaults();
  assert.equal(defaults.model, null);
  assert.equal(defaults.reasoningEffort, null);
});

test("readCodexDefaults: TOML value outside the whitelist -> null, never displayed as is", () => {
  writeFileSync(
    path.join(process.env.CODEX_HOME as string, "config.toml"),
    'model = "gpt 5.5 with spaces"\nmodel_reasoning_effort = "high"\n',
    "utf-8"
  );
  const defaults = readCodexDefaults();
  assert.equal(defaults.model, null, "exotic value discarded (unknown rather than incorrect)");
  assert.equal(defaults.reasoningEffort, "high", "the sane key of the same file is still read");
});

test("invoke: returned model/effort = the override when given, else the config.toml default", async () => {
  writeFileSync(
    path.join(process.env.CODEX_HOME as string, "config.toml"),
    'model = "gpt-default"\nmodel_reasoning_effort = "xhigh"\n',
    "utf-8"
  );
  const logger = new SessionLogger("prov-test-model");
  // Effort overridden, model inherited: mixed resolution
  const result = await fakeCodex("fake-codex.mjs").invoke({
    prompt: "x",
    tag: "round_1",
    logger,
    timeoutMs: 15_000,
    reasoningEffort: "high",
  });
  assert.equal(result.model, "gpt-default", "model inherited from config.toml");
  assert.equal(result.reasoningEffort, "high", "the override takes precedence");
});

// --- CodexProvider.invoke: full cycle against the fake-codex fixture ---

test("invoke new session: prompt through stdin, thread_id and usage returned, raw files saved", async () => {
  const logger = new SessionLogger("prov-test-1");
  const prompt = 'Review this plan.\nLine 2 with "quotes" and $variables.';
  const result = await fakeCodex("fake-codex.mjs").invoke({
    prompt,
    tag: "round_1",
    logger,
    timeoutMs: 15_000,
  });

  assert.equal(result.threadId, "11111111-2222-3333-4444-555555555555");
  const reply = JSON.parse(result.text);
  assert.equal(reply.verdict, "APPROVED");
  assert.equal(reply.stdin_length, prompt.length, "the prompt must arrive intact through stdin");
  assert.equal(result.usage?.input_tokens, 10);

  // Raw responses persisted before any parsing
  const rawDir = path.join(logsDir(), "raw", "prov-test-1");
  assert.ok(existsSync(path.join(rawDir, "round_1_stdout.jsonl")));
  assert.ok(existsSync(path.join(rawDir, "round_1_last-message.txt")));

  // Session JSONL log written
  const jsonl = readFileSync(path.join(logsDir(), "prov-test-1.jsonl"), "utf-8").trim().split("\n");
  const last = JSON.parse(jsonl[jsonl.length - 1]);
  assert.equal(last.event, "invoke_ok");
  assert.equal(last.resumed, false);
});

test("invoke resume: the provided thread_id is reused and re-emitted", async () => {
  const logger = new SessionLogger("prov-test-2");
  const threadId = "019f2d71-02e2-7ae1-911d-30452a0f901e";
  const result = await fakeCodex("fake-codex.mjs").invoke({
    prompt: "Round 2: re-review after fixes.",
    threadId,
    tag: "round_2",
    logger,
    timeoutMs: 15_000,
  });
  assert.equal(result.threadId, threadId);
});

test("invoke on a failing CLI: exec_failed ProviderError with full stderr and login hint", async () => {
  const logger = new SessionLogger("prov-test-3");
  await assert.rejects(
    fakeCodex("fake-codex-fail.mjs").invoke({ prompt: "x", tag: "round_1", logger, timeoutMs: 15_000 }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, "exec_failed");
      assert.match(err.message, /logged out/);
      assert.match(err.hint ?? "", /codex login/);
      return true;
    }
  );
  // The raw stderr is saved even on failure
  assert.ok(existsSync(path.join(logsDir(), "raw", "prov-test-3", "round_1_stderr.txt")));
});

test("invoke on exhausted quota: exec_failed with a quota hint (continue without review)", async () => {
  const logger = new SessionLogger("prov-test-quota");
  await assert.rejects(
    fakeCodex("fake-codex-quota.mjs").invoke({ prompt: "x", tag: "round_1", logger, timeoutMs: 15_000 }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, "exec_failed");
      assert.match(err.message, /usage limit/);
      assert.match(err.hint ?? "", /Codex usage quota reached/);
      return true;
    }
  );
});

test("hint priority: ambiguous stderr quota + login -> quota hint (not auth)", async () => {
  const logger = new SessionLogger("prov-test-prio-1");
  await assert.rejects(
    fakeCodex("fake-codex-quota-auth.mjs").invoke({ prompt: "x", tag: "round_1", logger, timeoutMs: 15_000 }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.hint ?? "", /Codex usage quota reached/);
      assert.ok(!(err.hint ?? "").includes("codex login"), "the auth hint must not win over quota");
      return true;
    }
  );
});

test("hint priority: exit 9009 wins over a stderr mentioning quota (not_found > quota)", async () => {
  const logger = new SessionLogger("prov-test-prio-2");
  await assert.rejects(
    fakeCodex("fake-codex-exit9009.mjs").invoke({ prompt: "x", tag: "round_1", logger, timeoutMs: 15_000 }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, "cli_not_found");
      assert.match(err.hint ?? "", /npm install -g @openai\/codex/);
      return true;
    }
  );
});

test("quota hint at round 1 (no thread_id): does NOT promise a resumable session", async () => {
  const logger = new SessionLogger("prov-test-quota-r1");
  await assert.rejects(
    fakeCodex("fake-codex-quota.mjs").invoke({ prompt: "x", tag: "round_1", logger, timeoutMs: 15_000 }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.hint ?? "", /new session: no thread_id/);
      assert.ok(!(err.hint ?? "").includes("stays resumable"), "no resume promise without a thread_id");
      return true;
    }
  );
});

test("quota hint on resume (thread_id provided): session resumable through the same thread_id", async () => {
  const logger = new SessionLogger("prov-test-quota-resume");
  await assert.rejects(
    fakeCodex("fake-codex-quota.mjs").invoke({
      prompt: "x",
      threadId: "019f2d71-02e2-7ae1-911d-30452a0f901e",
      tag: "round_2",
      logger,
      timeoutMs: 15_000,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.hint ?? "", /stays resumable later through the same thread_id/);
      return true;
    }
  );
});

test("invoke on an empty response (exit 0 without agent_message): empty_response ProviderError", async () => {
  const logger = new SessionLogger("prov-test-4");
  await assert.rejects(
    fakeCodex("fake-codex-empty.mjs").invoke({ prompt: "x", tag: "round_1", logger, timeoutMs: 15_000 }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, "empty_response");
      return true;
    }
  );
});

test("isAvailable returns false for a nonexistent CLI", async () => {
  const provider = new CodexProvider({ command: "clonst-nonexistent-cli", prefixArgs: [] });
  assert.equal(await provider.isAvailable(), false);
});

test("regression: a stale last-message is never re-read (empty_response, not the old content)", async () => {
  // Invocation 1: success, writes raw/<session>/round_1_last-message.txt
  const logger = new SessionLogger("prov-test-stale");
  const first = await fakeCodex("fake-codex.mjs").invoke({
    prompt: "first call",
    tag: "round_1",
    logger,
    timeoutMs: 15_000,
  });
  assert.match(first.text, /APPROVED/);

  // Invocation 2, SAME logger and SAME tag, CLI producing nothing:
  // must throw empty_response and above all not resurface the old APPROVED.
  await assert.rejects(
    fakeCodex("fake-codex-empty.mjs").invoke({ prompt: "second call", tag: "round_1", logger, timeoutMs: 15_000 }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, "empty_response");
      return true;
    }
  );
});

test("invoke on a nonexistent command: cli_not_found with an install hint (locale-independent)", async () => {
  const logger = new SessionLogger("prov-test-notfound");
  const provider = new CodexProvider({ command: "clonst-nonexistent-cli-xyz", prefixArgs: [] });
  await assert.rejects(
    provider.invoke({ prompt: "x", tag: "round_1", logger, timeoutMs: 15_000 }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, "cli_not_found");
      assert.match(err.hint ?? "", /npm install -g @openai\/codex/);
      return true;
    }
  );
});

test("invoke resuming with a DIFFERENT re-emitted thread_id: anomaly logged, response kept", async () => {
  const logger = new SessionLogger("prov-test-mismatch");
  const requested = "019f2d71-02e2-7ae1-911d-30452a0f901e";
  const result = await fakeCodex("fake-codex-wrongthread.mjs").invoke({
    prompt: "x",
    threadId: requested,
    tag: "round_2",
    logger,
    timeoutMs: 15_000,
  });
  // The (paid) response is kept, with the actually observed thread_id
  assert.equal(result.threadId, "99999999-8888-7777-6666-555555555555");
  assert.ok(result.text.length > 0);
  // But the anomaly is traced with both identifiers
  const jsonl = readFileSync(path.join(logsDir(), "prov-test-mismatch.jsonl"), "utf-8");
  assert.match(jsonl, /"event":"thread_id_mismatch"/);
  assert.match(jsonl, new RegExp(`"requested":"${requested}"`));
  assert.match(jsonl, /"received":"99999999-8888-7777-6666-555555555555"/);
});

test("invoke reports a usable response without a thread_id (resume impossible)", async () => {
  const logger = new SessionLogger("prov-test-nothread");
  // fake-codex-nothread emits an agent_message but no thread.started
  const result = await fakeCodex("fake-codex-nothread.mjs").invoke({
    prompt: "x",
    tag: "round_1",
    logger,
    timeoutMs: 15_000,
  });
  assert.equal(result.threadId, null);
  assert.ok(result.text.length > 0);
  const jsonl = readFileSync(path.join(logsDir(), "prov-test-nothread.jsonl"), "utf-8");
  assert.match(jsonl, /"event":"missing_thread_id"/);
});
