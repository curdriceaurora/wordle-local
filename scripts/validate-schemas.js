#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const projectRoot = path.resolve(__dirname, "..");
const leaderboardSchemaPath = path.join(projectRoot, "data", "leaderboard.schema.json");
const leaderboardDataPath = path.join(projectRoot, "data", "leaderboard.json");

function readJson(filePath, kind) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`[schema:check] Failed to read ${kind} file at ${filePath}: ${err.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`[schema:check] Invalid JSON in ${kind} file at ${filePath}: ${err.message}`);
  }
}

function formatValidationErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return "No validation details were returned.";
  }

  return errors
    .map((err, idx) => {
      const pathInfo = err.instancePath && err.instancePath.length > 0 ? err.instancePath : "/";
      const message = err.message || "validation error";
      return `${idx + 1}. path=${pathInfo} keyword=${err.keyword} message=${message}`;
    })
    .join("\n");
}

function runSchemaChecks() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true
  });
  addFormats(ajv);

  const schema = readJson(leaderboardSchemaPath, "schema");
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    throw new Error(`[schema:check] Failed to compile leaderboard schema: ${err.message}`);
  }

  const data = readJson(leaderboardDataPath, "data");
  const valid = validate(data);
  if (!valid) {
    const details = formatValidationErrors(validate.errors);
    throw new Error(`[schema:check] leaderboard.json failed validation:\n${details}`);
  }

  console.log(
    `[schema:check] OK: ${path.relative(projectRoot, leaderboardDataPath)} validates against ${path.relative(projectRoot, leaderboardSchemaPath)}`
  );
}

try {
  runSchemaChecks();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
