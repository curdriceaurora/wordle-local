#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const projectRoot = path.resolve(__dirname, "..");
const leaderboardSchemaPath = path.join(projectRoot, "data", "leaderboard.schema.json");
const leaderboardDataPath = path.join(projectRoot, "data", "leaderboard.json");
const providerManifestSchemaPath = path.join(
  projectRoot,
  "data",
  "providers",
  "provider-import-manifest.schema.json"
);
const providerManifestExamplePath = path.join(
  projectRoot,
  "data",
  "providers",
  "provider-import-manifest.example.json"
);
const languageRegistrySchemaPath = path.join(projectRoot, "data", "languages.schema.json");
const languageRegistryDataPath = path.join(projectRoot, "data", "languages.json");
const adminJobsSchemaPath = path.join(projectRoot, "data", "admin-jobs.schema.json");
const adminJobsExamplePath = path.join(projectRoot, "data", "admin-jobs.example.json");
const appConfigSchemaPath = path.join(projectRoot, "data", "app-config.schema.json");
const appConfigExamplePath = path.join(projectRoot, "data", "app-config.example.json");

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

  const checks = [
    {
      schemaPath: leaderboardSchemaPath,
      dataPath: leaderboardDataPath,
      schemaLabel: "leaderboard schema"
    },
    {
      schemaPath: providerManifestSchemaPath,
      dataPath: providerManifestExamplePath,
      schemaLabel: "provider import manifest schema"
    },
    {
      schemaPath: languageRegistrySchemaPath,
      dataPath: languageRegistryDataPath,
      schemaLabel: "language registry schema"
    },
    {
      schemaPath: adminJobsSchemaPath,
      dataPath: adminJobsExamplePath,
      schemaLabel: "admin jobs schema"
    },
    {
      schemaPath: appConfigSchemaPath,
      dataPath: appConfigExamplePath,
      schemaLabel: "app config schema"
    }
  ];

  checks.forEach(({ schemaPath, dataPath, schemaLabel }) => {
    const schema = readJson(schemaPath, "schema");
    let validate;
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      throw new Error(`[schema:check] Failed to compile ${schemaLabel}: ${err.message}`);
    }

    const data = readJson(dataPath, "data");
    const valid = validate(data);
    if (!valid) {
      const details = formatValidationErrors(validate.errors);
      throw new Error(
        `[schema:check] ${path.basename(dataPath)} failed validation against ${path.basename(schemaPath)}:\n${details}`
      );
    }

    console.log(
      `[schema:check] OK: ${path.relative(projectRoot, dataPath)} validates against ${path.relative(projectRoot, schemaPath)}`
    );
  });
}

try {
  runSchemaChecks();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
