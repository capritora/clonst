// Test fixture: mimics the `codex exec --json` contract observed during the probes
// (review/step_1.md, codex-cli 0.142.5) without consuming quota.
// - New session: fixed thread_id.
// - Resume (`exec resume <id>`): re-emits the resumed thread_id, like the real CLI.
// - Writes the last message to the --output-last-message file.
// - The reply encodes the received stdin size (proof the prompt got through).
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const NEW_THREAD_ID = "11111111-2222-3333-4444-555555555555";

let stdinData = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  stdinData += chunk;
});
process.stdin.on("end", () => {
  const resumeIndex = args.indexOf("resume");
  const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : NEW_THREAD_ID;
  const reply = JSON.stringify({ verdict: "APPROVED", stdin_length: stdinData.length });

  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } });
  emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5 } });

  const flagIndex = args.indexOf("--output-last-message");
  if (flagIndex >= 0 && flagIndex + 1 < args.length) {
    writeFileSync(args[flagIndex + 1], reply, "utf-8");
  }
  process.exit(0);
});
