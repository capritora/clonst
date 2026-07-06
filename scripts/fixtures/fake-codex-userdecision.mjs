// Test fixture: CHANGES_NEEDED with a "USER DECISION: " marked risk (intent
// drift routed to the human) plus decoys that must NOT trigger the detection
// (marker mid-text, marker-less risks). Real JSONL contract.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const NEW_THREAD_ID = "44444444-5555-6666-7777-888888888888";

process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const resumeIndex = args.indexOf("resume");
  const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : NEW_THREAD_ID;
  const reply = JSON.stringify({
    verdict: "CHANGES_NEEDED",
    score: 6,
    critique: "The retry change altered the checkout behavior.",
    required_changes: ["Add a bound to the retry loop"],
    suggestions: [],
    risks_identified: [
      "USER DECISION: the revision switched checkout from reserve-once to repeated automatic payment attempts - which behavior do you want?",
      "A note mentioning USER DECISION: mid-text must not trigger the checkpoint",
      "Plain technical risk without marker",
    ],
    _feedback: "",
  });

  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: reply } });
  emit({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 7 } });

  const flagIndex = args.indexOf("--output-last-message");
  if (flagIndex >= 0 && flagIndex + 1 < args.length) {
    writeFileSync(args[flagIndex + 1], reply, "utf-8");
  }
  process.exit(0);
});
