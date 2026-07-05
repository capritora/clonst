import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../utils/config.js";
import { configPath } from "../utils/paths.js";

// Every test isolates itself in a temporary CLONST_HOME (paths.ts reads the variable on every call)
beforeEach(() => {
  process.env.CLONST_HOME = mkdtempSync(path.join(os.tmpdir(), "clonst-test-"));
});

test("loadConfig returns the defaults when the file is absent", () => {
  assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
});

test("saveConfig then loadConfig round-trips faithfully", () => {
  const custom = { ...DEFAULT_CONFIG, suggested_max_rounds: 3, timeout_per_call_seconds: 120 };
  saveConfig(custom);
  assert.deepEqual(loadConfig(), custom);
});

test("loadConfig merges absent keys with the defaults", () => {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ suggested_max_rounds: 2 }), "utf-8");
  const config = loadConfig();
  assert.equal(config.suggested_max_rounds, 2);
  assert.equal(config.timeout_per_call_seconds, DEFAULT_CONFIG.timeout_per_call_seconds);
});

test("loadConfig on a corrupt file: defaults + .corrupt-* backup", () => {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), "{ not json", "utf-8");
  const config = loadConfig();
  assert.deepEqual(config, DEFAULT_CONFIG);
  const files = readdirSync(path.dirname(configPath()));
  assert.ok(
    files.some((f) => f.startsWith("config.json.corrupt-")),
    `corrupt backup missing, files: ${files.join(", ")}`
  );
});

test("loadConfig replaces values with an invalid type or bound by the defaults", () => {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(
    configPath(),
    JSON.stringify({
      suggested_max_rounds: "five",
      timeout_per_call_seconds: -1,
    }),
    "utf-8"
  );
  assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
});

test("loadConfig on a non-object JSON root: defaults + .corrupt-* backup", () => {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify([1, 2, 3]), "utf-8");
  assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  const files = readdirSync(path.dirname(configPath()));
  assert.ok(files.some((f) => f.startsWith("config.json.corrupt-")));
});

test("saveConfig leaves no temporary file behind", () => {
  saveConfig(DEFAULT_CONFIG);
  const files = readdirSync(path.dirname(configPath()));
  assert.ok(!files.some((f) => f.includes(".tmp-")), `leftover tmp file: ${files.join(", ")}`);
});

test("codex_model / codex_reasoning_effort overrides: null by default, safe values accepted", () => {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(
    configPath(),
    JSON.stringify({ codex_model: "gpt-5.5", codex_reasoning_effort: "high" }),
    "utf-8"
  );
  const config = loadConfig();
  assert.equal(config.codex_model, "gpt-5.5");
  assert.equal(config.codex_reasoning_effort, "high");
  // Absent = null (inherit from ~/.codex/config.toml)
  assert.equal(DEFAULT_CONFIG.codex_model, null);
  assert.equal(DEFAULT_CONFIG.codex_reasoning_effort, null);
});

test("default_language: null by default, valid code accepted, injection material rejected", () => {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  assert.equal(DEFAULT_CONFIG.default_language, null, "shipped unset: content-language behavior");

  writeFileSync(configPath(), JSON.stringify({ default_language: "fr" }), "utf-8");
  assert.equal(loadConfig().default_language, "fr");

  // Same whitelist as the language parameter: words and variants cannot pass
  for (const bad of ["French", "fr-approved", "en ignore all", 42]) {
    writeFileSync(configPath(), JSON.stringify({ default_language: bad }), "utf-8");
    assert.equal(loadConfig().default_language, null, `${JSON.stringify(bad)} must fall back to null`);
  }
});

test("invalid codex overrides (metacharacters, spaces, non-string): fall back to null", () => {
  // These values become CLI arguments: the whitelist is a security barrier
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(
    configPath(),
    JSON.stringify({ codex_model: "gpt 5; echo pwned", codex_reasoning_effort: 42 }),
    "utf-8"
  );
  const config = loadConfig();
  assert.equal(config.codex_model, null);
  assert.equal(config.codex_reasoning_effort, null);
});
