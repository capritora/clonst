// Test fixture: mimics a codex CLI whose subscription quota is exhausted.
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stderr.write("Error: You've hit your usage limit. Try again at 6:00 PM.\n");
  process.exit(1);
});
