// Test fixture: APPROVED consensus that still carries a "USER DECISION: "
// marked risk (with tolerated leading whitespace): the final report must relay
// it even though the review is closed. Real JSONL contract.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const NEW_THREAD_ID = "55555555-6666-7777-8888-999999999999";

process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const resumeIndex = args.indexOf("resume");
  const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : NEW_THREAD_ID;
  const reply = JSON.stringify({
    verdict: "APPROVED",
    score: 9,
    critique: "Solid plan.",
    required_changes: [],
    suggestions: [],
    risks_identified: [
      "  USER DECISION: the signup flow now requires email verification - keep it or return to one-click?",
    ],
    _feedback: "",
  });

  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } });
  emit({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 4 } });

  const flagIndex = args.indexOf("--output-last-message");
  if (flagIndex >= 0 && flagIndex + 1 < args.length) {
    writeFileSync(args[flagIndex + 1], reply, "utf-8");
  }
  process.exit(0);
});
