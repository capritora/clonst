import { spawn } from "node:child_process";
import { logStderr } from "./logger.js";

export interface SpawnCliOptions {
  /** Working directory of the process (project context for LLM CLIs). */
  cwd?: string;
  /** Timeout in milliseconds. Default: 600 000 (10 min, reasoning models are slow). */
  timeoutMs?: number;
  /** Content written to stdin then closed. Prompts go through here, never as arguments. */
  stdin?: string;
}

export interface SpawnCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export const DEFAULT_TIMEOUT_MS = 600_000;
/** After a timeout kill, max delay before giving up even if 'close' never fires. */
const KILL_GRACE_MS = 10_000;

// Variables inherited from the parent Claude Code session (Clonst is spawned by
// it). We do not propagate them to LLM CLIs: they can trigger nested-session
// behaviors.
const STRIPPED_ENV_PREFIXES = ["CLAUDECODE", "CLAUDE_CODE_"];

export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    // Case-insensitive: Windows environment variable names are case-insensitive
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Guard for dynamic identifiers (e.g. the thread_id returned by Codex).
 * Accepts only [A-Za-z0-9._-], enough for UUIDs and model names.
 * Do NOT use this for file paths: quoteArg handles those.
 */
export function assertSafeArg(arg: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(arg)) {
    throw new Error(`Unsafe dynamic argument for ${label}: "${arg}"`);
  }
  return arg;
}

// Characters that need no quoting (simple Windows/POSIX paths included).
const WIN_SAFE_ARG = /^[A-Za-z0-9_\-.:\\/=]+$/;
const POSIX_SAFE_ARG = /^[A-Za-z0-9_\-.:/=]+$/;

/**
 * Centralized argument quoting for shell:true (required on Windows for the npm
 * .cmd/.ps1 shims). Callers pass RAW arguments, never pre-quoted ones.
 *
 * Windows (cmd.exe + msvcrt parsing): the characters `"`, `%` and newlines have
 * no legitimate use in Clonst (flags, UUIDs, paths) and their cmd escaping rules
 * are too fragile: explicit rejection. Other arguments are wrapped in double
 * quotes, with trailing backslashes doubled (msvcrt rule: `C:\dir\` -> `"C:\dir\\"`).
 *
 * POSIX (/bin/sh): single quotes, with `'` escaped as `'\''`.
 */
export function quoteArg(arg: string): string {
  if (arg.length === 0) {
    return process.platform === "win32" ? '""' : "''";
  }
  if (process.platform === "win32") {
    if (WIN_SAFE_ARG.test(arg)) return arg;
    if (/["%\r\n]/.test(arg)) {
      throw new Error(`Argument cannot be safely represented under cmd.exe: "${arg}"`);
    }
    const withDoubledTrailingBackslashes = arg.replace(/(\\+)$/, "$1$1");
    return `"${withDoubledTrailingBackslashes}"`;
  }
  if (POSIX_SAFE_ARG.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    // proc.kill() would only kill the intermediate shell (shell:true): the child
    // codex.exe would survive and keep consuming quota. taskkill /T kills the tree.
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
    });
    killer.on("error", (err) => {
      logStderr(`taskkill unreachable for pid ${pid}: ${err.message}`);
    });
    killer.on("exit", (code) => {
      if (code !== 0) {
        logStderr(`taskkill failed for pid ${pid} (exit ${code}): orphan process possible`);
      }
    });
  } else {
    // The process was spawned with detached:true, so it leads its own group:
    // kill(-pid) kills the whole group (shell + child CLI).
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

// A simple executable name: letters/digits/._-, no path separator, no space.
const SIMPLE_COMMAND = /^[A-Za-z0-9._-]+$/;

/**
 * Spawns a CLI and captures stdout/stderr as UTF-8.
 *
 * Contract:
 * - `command` is a SIMPLE EXECUTABLE NAME resolved via PATH ("codex", "node", ...).
 *   Never a path (absolute or relative), never dynamic content: with shell:true,
 *   the command is not quoted by Node and a path with spaces would break
 *   (C:\Program Files\...). Validated here, fails early otherwise.
 * - `args` is passed RAW (no caller-side pre-quoting), quoting is centralized
 *   here through quoteArg. This covers dynamic paths passed as arguments, e.g.
 *   `--output-last-message <file under ~/.clonst/>` (tested, spaces included).
 * - Large variable content (prompts) goes through options.stdin.
 */
export function spawnCLI(
  command: string,
  args: string[],
  options: SpawnCliOptions = {}
): Promise<SpawnCliResult> {
  if (!SIMPLE_COMMAND.test(command)) {
    throw new Error(`spawnCLI expects a simple executable name resolved via PATH, got: "${command}"`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const quotedArgs = args.map(quoteArg);

  return new Promise((resolve, reject) => {
    const proc = spawn(command, quotedArgs, {
      cwd: options.cwd,
      env: cleanEnv(),
      shell: true,
      windowsHide: true,
      // POSIX: process group leader, so kill(-pid) kills the whole tree.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const settle = (result: SpawnCliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid !== undefined) killProcessTree(proc.pid);
      // If even the kill does not trigger 'close' (taskkill failure), return what
      // we have instead of blocking the caller forever.
      graceTimer = setTimeout(() => {
        logStderr(`process ${command} still alive ${KILL_GRACE_MS} ms after the kill, giving up`);
        settle({ stdout, stderr, exitCode: null, durationMs: Date.now() - start, timedOut: true });
      }, KILL_GRACE_MS);
    }, timeoutMs);

    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // EPIPE is possible if the process dies before the pipe closes, with or
    // without provided stdin (end() is called in every case): an error event
    // without a listener would crash the whole MCP server.
    proc.stdin.on("error", () => {});
    if (options.stdin !== undefined) {
      proc.stdin.write(options.stdin, "utf-8");
    }
    proc.stdin.end();

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(err);
    });

    proc.on("close", (code) => {
      settle({
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}
