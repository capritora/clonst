// Test fixture: mimics a failing codex CLI (expired auth), non-zero exit code.
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("Error: you are logged out. Run codex login.\n");
  process.exit(1);
});
process.stdin.on("data", () => {});
