// Test fixture: mimics a codex CLI that, on resume, re-emits a thread_id
// DIFFERENT from the requested one (session divergence).
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const reply = JSON.stringify({ verdict: "APPROVED", note: "session divergente" });
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "thread.started", thread_id: "99999999-8888-7777-6666-555555555555" });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } });
  emit({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 3 } });
  const flagIndex = args.indexOf("--output-last-message");
  if (flagIndex >= 0 && flagIndex + 1 < args.length) {
    writeFileSync(args[flagIndex + 1], reply, "utf-8");
  }
  process.exit(0);
});
