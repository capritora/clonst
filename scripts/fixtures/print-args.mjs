// Test fixture: writes the JSON of the received arguments (minus node + script) to stdout.
// Used to verify that spawnCLI's centralized quoting passes arguments through intact.
process.stdout.write(JSON.stringify(process.argv.slice(2)));
