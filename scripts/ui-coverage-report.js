const fs = require("fs");
const path = require("path");
const { createCoverageMap } = require("istanbul-lib-coverage");
const { createContext } = require("istanbul-lib-report");
const reports = require("istanbul-reports");
const v8toIstanbul = require("v8-to-istanbul");

const root = path.join(__dirname, "..");
const rawDir = path.join(root, "coverage", "ui", "raw");
const reportDir = path.join(root, "coverage", "ui", "report");
const summaryFile = path.join(root, "coverage", "ui", "coverage-summary.json");

function resolveScriptFile(scriptUrl) {
  try {
    const url = new URL(scriptUrl);
    if (url.pathname === "/app.js") {
      const distFile = path.join(root, "public", "dist", "app.js");
      if (fs.existsSync(distFile)) return distFile;
      return path.join(root, "public", "app.js");
    }
  } catch (err) {
    // Ignore invalid URLs.
  }
  return null;
}

function loadRawEntries() {
  if (!fs.existsSync(rawDir)) return [];
  const files = fs.readdirSync(rawDir).filter((entry) => entry.endsWith(".json"));
  return files.flatMap((file) => {
    const raw = fs.readFileSync(path.join(rawDir, file), "utf8");
    return JSON.parse(raw);
  });
}

async function buildCoverage() {
  const entries = loadRawEntries();
  if (!entries.length) {
    console.warn("No UI coverage data found. Ensure UI_COVERAGE=1 when running Playwright.");
    return null;
  }

  const coverageMap = createCoverageMap({});
  for (const entry of entries) {
    if (!entry.url || !entry.functions) continue;
    const filePath = resolveScriptFile(entry.url);
    if (!filePath) continue;
    const converter = v8toIstanbul(filePath, 0, {
      source: fs.readFileSync(filePath, "utf8")
    });
    await converter.load();
    converter.applyCoverage(entry.functions);
    coverageMap.merge(converter.toIstanbul());
  }

  return coverageMap;
}

async function main() {
  const coverageMap = await buildCoverage();
  if (!coverageMap) {
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(reportDir, { recursive: true });
  const context = createContext({ dir: reportDir, coverageMap });
  reports.create("html").execute(context);
  reports.create("text-summary").execute(context);
  fs.writeFileSync(summaryFile, JSON.stringify(coverageMap.getCoverageSummary(), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
