// Test fixture: mimics a codex CLI that exits 0 without any agent message
// (no agent_message event, no --output-last-message file written).
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "aaaa-bbbb" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }) + "\n");
  process.exit(0);
});
