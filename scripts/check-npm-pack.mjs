#!/usr/bin/env node
// Release guard: verifies that the npm package contains ONLY dist/ (without
// dist/tests/) plus package.json, README.md and LICENSE. Fails on any source,
// test, probe or personal file. Run by CI; manual run: node scripts/check-npm-pack.mjs
import { execSync } from "node:child_process";

// Fixed literal command, no variable content (execSync's shell is required on
// Windows anyway, where npm is a .cmd shim).
const report = JSON.parse(
  execSync("npm pack --dry-run --json", { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
);
const files = report[0].files.map((f) => f.path);
const allowed = /^(dist\/(?!tests\/)|package\.json$|README\.md$|LICENSE$)/;
const banned = files.filter((p) => !allowed.test(p));

if (banned.length > 0) {
  console.error("FAIL: unexpected files in the npm package:");
  for (const p of banned) console.error(`  - ${p}`);
  process.exit(1);
}
if (!files.some((p) => p === "dist/index.js")) {
  console.error("FAIL: dist/index.js missing from the package (build first: npm run build)");
  process.exit(1);
}
console.log(`OK: npm package contains ${files.length} files, dist-only as expected`);
