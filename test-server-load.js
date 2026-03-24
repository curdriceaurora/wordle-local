const { spawnSync } = require("node:child_process");
const path = require("node:path");

const filesToCheck = [
  "server.js",
  "routes/admin.js",
  "routes/game.js",
  "routes/meta.js",
  "routes/stats.js"
];

for (const file of filesToCheck) {
  const fullPath = path.join(__dirname, file);
  const result = spawnSync(process.execPath, ["--check", fullPath], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`✗ Syntax check failed for ${file}`);
    if (result.stdout) {
      console.error(result.stdout.trim());
    }
    if (result.stderr) {
      console.error(result.stderr.trim());
    }
    process.exit(1);
  }
}

console.log("✓ Syntax checks passed");
