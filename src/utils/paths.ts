import os from "node:os";
import path from "node:path";

/**
 * Root of Clonst's persistent data (config, logs, raw responses).
 * Overridable through CLONST_HOME (used by tests to isolate themselves).
 */
export function clonstHome(): string {
  return process.env.CLONST_HOME || path.join(os.homedir(), ".clonst");
}

export function logsDir(): string {
  return path.join(clonstHome(), "logs");
}

export function configPath(): string {
  return path.join(clonstHome(), "config.json");
}
