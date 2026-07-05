// Test fixture: "command not found" exit code with a stderr mentioning quota.
// Expected priority is not_found > quota: the shell exit code is more reliable
// than the text. The code is platform-dependent because POSIX truncates exit
// codes to 8 bits (9009 would arrive as 49): cmd.exe uses 9009, sh uses 127 -
// both are in the provider's locale-independent detection.
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stderr.write("something about usage limit\n");
  process.exit(process.platform === "win32" ? 9009 : 127);
});
