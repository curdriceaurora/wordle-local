const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const coverageDir = path.join(root, "coverage", "ui");
const distDir = path.join(root, "public", "dist");

fs.rmSync(coverageDir, { recursive: true, force: true });
fs.rmSync(distDir, { recursive: true, force: true });
