// Test fixture: mimics a codex CLI that replies correctly (agent_message)
// but never emits thread.started (session resume impossible).
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "response without a session" } });
  emit({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } });
  process.exit(0);
});
