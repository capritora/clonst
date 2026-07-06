#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodexProvider } from "./providers/codex.js";
import { ReportError, sealSummary } from "./core/report.js";
import { formatReviewError, reviewInputShape, reviewOutputShape, runReview } from "./tools/review.js";
import { loadConfig } from "./utils/config.js";
import { logStderr } from "./utils/logger.js";
import { logsDir } from "./utils/paths.js";
import { spawnCLI } from "./utils/process.js";

export const SERVER_NAME = "clonst";
// Single source of truth: package.json, one level above dist/index.js both in
// the repo and in the published package. A hardcoded copy here desynchronizes
// on every `npm version` bump (caught by the smoke test before the 1.1.1 publish).
export const SERVER_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

// IMPORTANT: with the stdio transport, stdout is reserved for the MCP protocol.
// All human-readable logging goes to stderr (logStderr), never console.log.

async function main(): Promise<void> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "clonst_ping",
    {
      description:
        "Full Clonst server diagnostic: health, codex CLI availability and version, " +
        "login status, loaded config, logs directory. Consumes no LLM quota.",
      inputSchema: {},
    },
    async () => {
      const [versionResult, loginResult] = await Promise.all([
        spawnCLI("codex", ["--version"], { timeoutMs: 15_000 }).catch(() => null),
        spawnCLI("codex", ["login", "status"], { timeoutMs: 15_000 }).catch(() => null),
      ]);
      const codexAvailable = versionResult?.exitCode === 0;
      const loggedIn = loginResult?.exitCode === 0;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              server: SERVER_NAME,
              version: SERVER_VERSION,
              node: process.version,
              codex_available: codexAvailable,
              codex_version: codexAvailable ? versionResult.stdout.trim() : null,
              codex_logged_in: codexAvailable ? loggedIn : null,
              config: loadConfig(),
              logs_dir: logsDir(),
              ...(codexAvailable
                ? loggedIn
                  ? {}
                  : { hint: "Reconnect the CLI: codex login" }
                : { hint: "Install the CLI: npm install -g @openai/codex, then codex login" }),
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "clonst_review",
    {
      description:
        "Have a plan, code or proposal critiqued by Codex (a second LLM, through its CLI and the user's " +
        "ChatGPT subscription). One call = one structured critique (APPROVED/CHANGES_NEEDED verdict, " +
        "required changes, suggestions, risks). The revision loop lives on your side: apply the critiques, " +
        "then call this tool again with the revised content and the returned thread_id - the reviewer keeps " +
        "its session memory across rounds. Loop until consensus=true, following the returned next_action " +
        "field, or until the user decides to stop. " +
        "WHEN TO USE IT: the criterion is LOGIC, not size. Call it by default, without being asked, for any " +
        "development that touches the project's logic or behavior (business logic, computations, data flows, " +
        "models, routes, APIs, state, error handling, concurrency, security, migrations), and for plans and " +
        "architecture decisions before coding. Do NOT use it for pure presentation (static HTML/CSS, copy), " +
        "documentation, renames without behavior change, or throwaway content the user will not run. Every " +
        "call consumes the user's subscription quota; when the scope is unclear, ask the user.",
      inputSchema: reviewInputShape,
      outputSchema: reviewOutputShape,
    },
    async (input) => {
      try {
        const result = await runReview(input, new CodexProvider(), loadConfig());
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify(formatReviewError(err), null, 2) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "clonst_report_summary",
    {
      description:
        "Seal your plain-language summary into the structured review report file, verbatim. " +
        "Call it once after a consensus, with the report_id returned by clonst_review (NOT the " +
        "thread_id: report_id identifies the report file, thread_id resumes the reviewer session) " +
        "and the exact text of the final report you gave the user. Metadata-only: no reviewer " +
        "spawn, no LLM quota. Idempotent: calling it again overwrites the summary.",
      inputSchema: {
        report_id: z
          .string()
          .regex(/^(?!\.+$)[A-Za-z0-9._-]+$/)
          .describe("The report_id returned by clonst_review (distinct from thread_id)."),
        summary: z
          .string()
          .min(1)
          .describe("The exact plain-language summary you gave the user, verbatim."),
      },
      outputSchema: {
        status: z.literal("ok"),
        report_path: z.string(),
      },
    },
    async (input) => {
      try {
        const { reportPath } = await sealSummary(input.report_id, input.summary);
        const result = { status: "ok" as const, report_path: reportPath };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (err) {
        const message =
          err instanceof ReportError
            ? err.message
            : `Sealing failed: ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", message }) }],
          isError: true,
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr(`v${SERVER_VERSION} started (stdio transport)`);
}

main().catch((err) => {
  logStderr(`Fatal startup error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
