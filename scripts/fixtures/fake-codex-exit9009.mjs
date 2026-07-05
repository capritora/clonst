// Test fixture: exit code 9009 (cmd.exe "command not found" code) with a
// stderr mentioning quota. Expected priority is not_found > quota: the shell
// exit code is more reliable than the text.
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stderr.write("something about usage limit\n");
  process.exit(9009);
});
