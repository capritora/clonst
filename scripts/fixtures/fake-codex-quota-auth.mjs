// Test fixture: AMBIGUOUS stderr containing both a quota signal and an
// auth signal ("login"). Expected priority is quota > auth.
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stderr.write("Error 429: You've hit your usage limit. Please login to upgrade your plan.\n");
  process.exit(1);
});
