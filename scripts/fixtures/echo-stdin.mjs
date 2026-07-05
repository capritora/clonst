// Test fixture: reads stdin fully and writes it to stdout with a prefix.
let data = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write("ECHO:" + data);
  process.exit(0);
});
