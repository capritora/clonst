#!/usr/bin/env node
// Automated MCP smoke test, no LLM call: spawns dist/index.js and checks
// the initialize -> tools/list -> tools/call clonst_ping sequence.
// Protocol-compliant handshake: each request is sent only after the response
// to the previous one (notifications/initialized goes out after the initialize response).
// Usage: npm run smoke  (requires a prior build)

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, "dist", "index.js");
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")).version;

if (!existsSync(serverPath)) {
  console.error("dist/index.js missing: run `npm run build` first.");
  process.exit(1);
}

const TIMEOUT_MS = 15000;
const responses = new Map();

const proc = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "ignore"] });

const timeout = setTimeout(() => {
  console.error(`FAIL: no complete response after ${TIMEOUT_MS} ms (received: ${[...responses.keys()].join(", ") || "none"})`);
  proc.kill();
  process.exit(1);
}, TIMEOUT_MS);

proc.on("error", (err) => {
  console.error(`FAIL: server spawn: ${err.message}`);
  process.exit(1);
});

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

// Step machine: when the response with id N arrives, send the next request.
function onResponse(msg) {
  responses.set(msg.id, msg);
  switch (msg.id) {
    case 1:
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      break;
    case 2:
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "clonst_ping", arguments: {} } });
      break;
    case 3:
      // Invalid call (missing content): the SDK's zod validation must reject
      // BEFORE the handler (so no codex spawn, zero quota).
      send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "clonst_review", arguments: {} } });
      break;
    case 4:
      finish();
      break;
  }
}

let buffer = "";
proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) onResponse(msg);
  }
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } },
});

function assert(condition, label) {
  if (condition) {
    console.log(`OK    ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    process.exitCode = 1;
  }
}

function finish() {
  clearTimeout(timeout);
  proc.kill();

  const init = responses.get(1);
  assert(init?.result?.serverInfo?.name === "clonst", "initialize: serverInfo.name === 'clonst'");
  // Release-metadata guard: SERVER_VERSION (src/index.ts) must match package.json
  assert(
    init?.result?.serverInfo?.version === packageVersion,
    `initialize: serverInfo.version (${init?.result?.serverInfo?.version}) === package.json version (${packageVersion})`
  );

  const tools = responses.get(2)?.result?.tools ?? [];
  assert(tools.some((t) => t.name === "clonst_ping"), "tools/list: clonst_ping present");
  assert(tools.some((t) => t.name === "clonst_review"), "tools/list: clonst_review present");
  const reviewTool = tools.find((t) => t.name === "clonst_review");
  assert(
    reviewTool?.inputSchema?.required?.includes("content"),
    "clonst_review: input schema exposed with content required"
  );
  assert(
    reviewTool?.outputSchema?.properties?.next_action_kind !== undefined,
    "clonst_review: typed output schema exposed (next_action_kind)"
  );

  const callText = responses.get(3)?.result?.content?.[0]?.text;
  let pingPayload = null;
  try {
    pingPayload = JSON.parse(callText);
  } catch {
    // left null, the next assertion will fail with a clear message
  }
  assert(pingPayload?.status === "ok", "tools/call clonst_ping: status === 'ok'");
  assert(typeof pingPayload?.codex_available === "boolean", "clonst_ping: codex_available is a boolean");

  // SDK error format on invalid arguments: JSON-RPC error (code -32602)
  // or isError result, depending on the SDK version. We document what is observed.
  const invalidCall = responses.get(4);
  const isJsonRpcError = invalidCall?.error !== undefined;
  const isToolError = invalidCall?.result?.isError === true;
  assert(
    isJsonRpcError || isToolError,
    "clonst_review without content: rejected by validation (JSON-RPC error or isError)"
  );
  console.log(
    `      (observed format: ${isJsonRpcError ? `JSON-RPC error code ${invalidCall.error.code}` : "isError result"})`
  );

  console.log(process.exitCode ? "\nMCP smoke test: FAIL" : "\nMCP smoke test: SUCCESS");
  process.exit(process.exitCode ?? 0);
}
