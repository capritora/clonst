// Test fixture: sleeps 30 s (used to test spawnCLI's timeout + kill tree).
setTimeout(() => {
  process.exit(0);
}, 30_000);
