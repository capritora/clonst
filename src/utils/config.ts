import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SAFE_LANGUAGE_TAG } from "./language.js";
import { clonstHome, configPath } from "./paths.js";
import { logStderr } from "./logger.js";

export interface ClonstConfig {
  /** Period of the user check-in (rounds 5, 10, 15... by default). NOT a limit. */
  suggested_max_rounds: number;
  /** Timeout of one CLI call, in seconds. */
  timeout_per_call_seconds: number;
  /**
   * Codex model for reviews (e.g. "gpt-5.5"). null = inherit the model
   * configured in ~/.codex/config.toml (shared with the VS Code extension).
   * Lets Clonst use a different setting without touching the extension.
   */
  codex_model: string | null;
  /** Codex reasoning effort for reviews (e.g. "high", "xhigh"). null = inherit. */
  codex_reasoning_effort: string | null;
  /**
   * Default language for the reviewer's free-text output, as a
   * language[-Script][-Region] code (e.g. "fr", "pt-BR"). Used when the caller
   * does not pass the language parameter. null = the reviewer follows the
   * language of the reviewed content.
   */
  default_language: string | null;
}

// NB: no default_reviewer field as long as Codex is the only implemented
// provider (a config promising "gemini" without an implementation would lie).
export const DEFAULT_CONFIG: ClonstConfig = {
  suggested_max_rounds: 5,
  timeout_per_call_seconds: 600,
  codex_model: null,
  codex_reasoning_effort: null,
  default_language: null,
};

// These values become CLI arguments (-c model=...): same whitelist as
// assertSafeArg, never a space or a shell metacharacter. No closed enum
// (codex models and effort tiers evolve): codex itself rejects an unknown
// value with a clear message.
const SAFE_OVERRIDE = /^[A-Za-z0-9._-]+$/;

function normalizeOverride(parsed: Record<string, unknown>, key: "codex_model" | "codex_reasoning_effort"): string | null {
  const value = parsed[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && SAFE_OVERRIDE.test(value)) return value;
  logStderr(`config: invalid ${key} (${JSON.stringify(value)}), inheriting the global codex config`);
  return null;
}

/**
 * Validates the type and bounds of each key: an invalid value falls back to the
 * default with a stderr warning (an aberrant value is never propagated silently).
 */
export function normalizeConfig(parsed: Record<string, unknown>): ClonstConfig {
  const config = { ...DEFAULT_CONFIG };

  const rounds = parsed["suggested_max_rounds"];
  if (rounds !== undefined) {
    if (typeof rounds === "number" && Number.isInteger(rounds) && rounds >= 1 && rounds <= 50) {
      config.suggested_max_rounds = rounds;
    } else {
      logStderr(`config: invalid suggested_max_rounds (${JSON.stringify(rounds)}), using default ${DEFAULT_CONFIG.suggested_max_rounds}`);
    }
  }

  const timeout = parsed["timeout_per_call_seconds"];
  if (timeout !== undefined) {
    if (typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 10 && timeout <= 7200) {
      config.timeout_per_call_seconds = timeout;
    } else {
      logStderr(`config: invalid timeout_per_call_seconds (${JSON.stringify(timeout)}), using default ${DEFAULT_CONFIG.timeout_per_call_seconds}`);
    }
  }

  config.codex_model = normalizeOverride(parsed, "codex_model");
  config.codex_reasoning_effort = normalizeOverride(parsed, "codex_reasoning_effort");

  const language = parsed["default_language"];
  if (language !== undefined && language !== null) {
    // Same shape as the language parameter (and re-validated at resolution):
    // language[-Script][-Region] only, so the value can never carry words.
    if (typeof language === "string" && SAFE_LANGUAGE_TAG.test(language)) {
      config.default_language = language;
    } else {
      logStderr(`config: invalid default_language (${JSON.stringify(language)}), the reviewer will use the content's language`);
    }
  }

  return config;
}

/**
 * Loads the persistent config, merged with the defaults (absent keys take the
 * default value, invalid values too, with a warning). Absent file = defaults.
 * Corrupt file = defaults, with the corrupt file backed up (never a silent loss).
 */
export function loadConfig(): ClonstConfig {
  const file = configPath();
  if (!existsSync(file)) {
    return { ...DEFAULT_CONFIG };
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("the JSON root is not an object");
    }
    return normalizeConfig(parsed);
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, backup);
      logStderr(`config.json corrupt (${err instanceof Error ? err.message : String(err)}), backed up to ${backup}, using defaults`);
    } catch {
      logStderr(`config.json corrupt and backup impossible, using defaults`);
    }
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Writes the config atomically (tmp + rename) to avoid corruption if a crash
 * happens mid-write.
 */
export function saveConfig(config: ClonstConfig): void {
  const file = configPath();
  mkdirSync(clonstHome(), { recursive: true });
  const tmp = path.join(path.dirname(file), `.config.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  renameSync(tmp, file);
}
