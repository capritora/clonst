// Test fixture: echoes the FULL prompt received on stdin back inside the
// critique field, so tests can assert what actually reached the reviewer
// (language directive, CLONST.md guidelines...). Real JSONL contract.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const reply = JSON.stringify({
    verdict: "CHANGES_NEEDED",
    score: 5,
    critique: stdin,
    required_changes: ["placeholder"],
    suggestions: [],
    risks_identified: [],
    _feedback: "",
  });
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "thread.started", thread_id: "33333333-4444-5555-6666-777777777777" });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } });
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  const flagIndex = args.indexOf("--output-last-message");
  if (flagIndex >= 0 && flagIndex + 1 < args.length) {
    writeFileSync(args[flagIndex + 1], reply, "utf-8");
  }
  process.exit(0);
});
