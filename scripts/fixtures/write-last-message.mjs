// Test fixture: mimics the `--output-last-message <file>` contract of codex exec.
// Writes a fixed content to the file passed after the flag, like the CLI would.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flagIndex = args.indexOf("--output-last-message");
if (flagIndex === -1 || flagIndex + 1 >= args.length) {
  process.stderr.write("--output-last-message flag missing or without a value\n");
  process.exit(1);
}
writeFileSync(args[flagIndex + 1], "last agent message", "utf-8");
process.exit(0);
