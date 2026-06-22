const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const routesDir = path.join(projectRoot, "routes");
const routeFiles = fs.readdirSync(routesDir)
  .filter((name) => name.endsWith(".js"))
  .sort()
  .map((name) => path.join("routes", name));

const filesToCheck = ["server.js", ...routeFiles];

for (const file of filesToCheck) {
  const fullPath = path.join(projectRoot, file);
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
