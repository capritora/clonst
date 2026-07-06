// Test fixture: valid CHANGES_NEEDED verdict with a "USER DECISION: " marked
// risk but NO thread.started event: the resume-impossible branch must dominate
// the user-decision checkpoint, with the relay still appended. Real JSONL contract.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);

process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const reply = JSON.stringify({
    verdict: "CHANGES_NEEDED",
    score: 6,
    critique: "Timeout missing, and the checkout behavior changed.",
    required_changes: ["Add a timeout"],
    suggestions: [],
    risks_identified: [
      "USER DECISION: the checkout flow changed from one-click to two steps - which one do you want?",
    ],
    _feedback: "",
  });

  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } });
  emit({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } });

  const flagIndex = args.indexOf("--output-last-message");
  if (flagIndex >= 0 && flagIndex + 1 < args.length) {
    writeFileSync(args[flagIndex + 1], reply, "utf-8");
  }
  process.exit(0);
});
