// Test fixture: mimics a Codex reviewer requesting changes
// (CHANGES_NEEDED verdict with required_changes), real JSONL contract.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const NEW_THREAD_ID = "22222222-3333-4444-5555-666666666666";

process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const resumeIndex = args.indexOf("resume");
  const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : NEW_THREAD_ID;
  const reply = JSON.stringify({
    verdict: "CHANGES_NEEDED",
    score: 5,
    critique: "The plan does not handle the timeout.",
    required_changes: ["Add a timeout to the API call"],
    suggestions: ["Document the config"],
    risks_identified: ["Silent hang"],
    _feedback: "",
  });

  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } });
  emit({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 15 } });

  const flagIndex = args.indexOf("--output-last-message");
  if (flagIndex >= 0 && flagIndex + 1 < args.length) {
    writeFileSync(args[flagIndex + 1], reply, "utf-8");
  }
  process.exit(0);
});
