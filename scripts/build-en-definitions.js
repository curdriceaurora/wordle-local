#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const WORD_LIST_PATH = path.join(__dirname, "..", "data", "dictionaries", "en.txt");
const OUTPUT_PATH = path.join(__dirname, "..", "data", "dictionaries", "en-definitions.json");
const INDEX_OUTPUT_DIR = path.join(__dirname, "..", "data", "dictionaries", "en-definitions-index");
const INDEX_MANIFEST_PATH = path.join(INDEX_OUTPUT_DIR, "manifest.json");
const MAX_DEFINITION_LENGTH = 220;
const SHARD_IDS = Object.freeze("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
const TYPE_TO_POS = Object.freeze({
  1: "noun",
  2: "verb",
  3: "adj",
  4: "adv",
  5: "adj"
});
const POS_FILES = Object.freeze(["noun", "verb", "adj", "adv"]);

function readLines(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.split(/\r?\n/);
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

function shortDefinition(gloss) {
  if (!gloss) return "";
  const withoutExamples = gloss.split('; "')[0];
  const normalized = withoutExamples.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= MAX_DEFINITION_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_DEFINITION_LENGTH - 3)}...`;
}

function loadWordNetGlosses(wordNetPath) {
  const byPos = {};

  for (const pos of POS_FILES) {
    const filePath = path.join(wordNetPath, `data.${pos}`);
    const lines = readLines(filePath);
    const map = new Map();

    for (const line of lines) {
      if (!/^\d{8}\s/.test(line)) continue;
      const separatorIndex = line.indexOf(" | ");
      if (separatorIndex < 0) continue;
      const offset = line.slice(0, 8);
      const definition = shortDefinition(line.slice(separatorIndex + 3));
      if (!definition) continue;
      map.set(offset, definition);
    }

    byPos[pos] = map;
  }

  return byPos;
}

function loadLemmaDefinitions(wordNetPath, glossesByPos) {
  const indexSensePath = path.join(wordNetPath, "index.sense");
  const lines = readLines(indexSensePath);
  const lemmaDefinitions = new Map();

  for (const line of lines) {
    const match = line.match(/^([^\s]+)\s+(\d{8})\s+(\d+)\s+\d+$/);
    if (!match) continue;

    const senseKey = match[1];
    const offset = match[2];
    const senseNumber = Number(match[3]);
    const typeMatch = senseKey.match(/%([1-5]):/);
    if (!typeMatch) continue;

    const pos = TYPE_TO_POS[Number(typeMatch[1])];
    const definition = glossesByPos[pos]?.get(offset);
    if (!definition) continue;

    const lemma = senseKey.split("%")[0].replace(/_/g, "").toUpperCase();
    if (!/^[A-Z]+$/.test(lemma)) continue;

    const current = lemmaDefinitions.get(lemma);
    if (!current || senseNumber < current.senseNumber) {
      lemmaDefinitions.set(lemma, { senseNumber, definition });
    }
  }

  return lemmaDefinitions;
}

function addCandidate(list, candidate) {
  if (!candidate) return;
  if (candidate.length < 3) return;
  if (!/^[A-Z]+$/.test(candidate)) return;
  if (list.includes(candidate)) return;
  list.push(candidate);
}

function buildCandidates(word) {
  const candidates = [word];

  if (word.endsWith("IES") && word.length > 4) {
    addCandidate(candidates, `${word.slice(0, -3)}Y`);
  }
  if (word.endsWith("ES") && word.length > 3) {
    addCandidate(candidates, word.slice(0, -2));
    addCandidate(candidates, word.slice(0, -1));
  }
  if (word.endsWith("S") && word.length > 3) {
    addCandidate(candidates, word.slice(0, -1));
  }
  if (word.endsWith("IED") && word.length > 4) {
    addCandidate(candidates, `${word.slice(0, -3)}Y`);
  }
  if (word.endsWith("ED") && word.length > 3) {
    addCandidate(candidates, word.slice(0, -2));
    addCandidate(candidates, word.slice(0, -1));
    addCandidate(candidates, `${word.slice(0, -2)}E`);
  }
  if (word.endsWith("ING") && word.length > 5) {
    addCandidate(candidates, word.slice(0, -3));
    addCandidate(candidates, `${word.slice(0, -3)}E`);
  }
  if (word.endsWith("ER") && word.length > 4) {
    addCandidate(candidates, word.slice(0, -2));
    addCandidate(candidates, word.slice(0, -1));
  }
  if (word.endsWith("EST") && word.length > 5) {
    addCandidate(candidates, word.slice(0, -3));
    addCandidate(candidates, word.slice(0, -2));
  }
  if (word.endsWith("LY") && word.length > 4) {
    addCandidate(candidates, word.slice(0, -2));
  }
  if (word.endsWith("NESS") && word.length > 6) {
    addCandidate(candidates, word.slice(0, -4));
  }

  return candidates;
}

function buildDefinitions(wordList, lemmaDefinitions) {
  const definitions = {};

  for (const word of wordList) {
    const candidates = buildCandidates(word);
    for (const candidate of candidates) {
      const match = lemmaDefinitions.get(candidate);
      if (!match) continue;
      definitions[word] = match.definition;
      break;
    }
  }

  return definitions;
}

function writeDefinitionIndexArtifacts(payload) {
  fs.mkdirSync(INDEX_OUTPUT_DIR, { recursive: true });
  fs.readdirSync(INDEX_OUTPUT_DIR).forEach((entry) => {
    if (entry.endsWith(".json")) {
      fs.unlinkSync(path.join(INDEX_OUTPUT_DIR, entry));
    }
  });

  const shards = {};
  SHARD_IDS.forEach((shardId) => {
    shards[shardId] = {};
  });

  const sortedWords = Object.keys(payload.definitions).sort();
  for (const word of sortedWords) {
    const shardId = word[0];
    if (!shards[shardId]) {
      continue;
    }
    shards[shardId][word] = payload.definitions[word];
  }

  const manifest = {
    version: 1,
    generatedAt: payload.generatedAt,
    source: payload.source,
    totalWords: payload.totalWords,
    coveredWords: payload.coveredWords,
    coveragePercent: payload.coveragePercent,
    shards: {}
  };

  SHARD_IDS.forEach((shardId) => {
    const definitions = shards[shardId];
    const count = Object.keys(definitions).length;
    if (count === 0) {
      return;
    }
    const fileName = `${shardId}.json`;
    const filePath = path.join(INDEX_OUTPUT_DIR, fileName);
    fs.writeFileSync(filePath, `${JSON.stringify(definitions)}\n`, "utf8");
    manifest.shards[shardId] = {
      file: fileName,
      count
    };
  });

  fs.writeFileSync(INDEX_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    shardCount: Object.keys(manifest.shards).length,
    outputDir: INDEX_OUTPUT_DIR
  };
}

function readExistingDefinitionsPayload(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Definition payload must be an object.");
  }
  if (!parsed.definitions || typeof parsed.definitions !== "object" || Array.isArray(parsed.definitions)) {
    throw new Error("Definition payload is missing a valid `definitions` object.");
  }
  return {
    generatedAt: String(parsed.generatedAt || new Date().toISOString()),
    source: String(parsed.source || "unknown"),
    totalWords: Number(parsed.totalWords) || Object.keys(parsed.definitions).length,
    coveredWords: Number(parsed.coveredWords) || Object.keys(parsed.definitions).length,
    coveragePercent:
      Number(parsed.coveragePercent) ||
      Number(
        (
          (Object.keys(parsed.definitions).length /
            Math.max(Number(parsed.totalWords) || Object.keys(parsed.definitions).length, 1)) *
          100
        ).toFixed(2)
      ),
    definitions: parsed.definitions
  };
}

function main() {
  const indexOnly = process.argv.includes("--index-only");
  if (indexOnly) {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error(`Cannot build definition index. Missing ${OUTPUT_PATH}.`);
      process.exit(1);
    }
    let payload;
    try {
      payload = readExistingDefinitionsPayload(OUTPUT_PATH);
    } catch (err) {
      console.error(`Invalid definitions file: ${err.message}`);
      process.exit(1);
    }
    const indexDetails = writeDefinitionIndexArtifacts(payload);
    console.log(
      `Wrote indexed definition shards (${indexDetails.shardCount}) to ${indexDetails.outputDir}`
    );
    return;
  }

  let wordNet;
  try {
    wordNet = require("wordnet-db");
  } catch (err) {
    console.error("Missing dependency: wordnet-db. Run `npm install` first.");
    process.exit(1);
  }

  const wordNetPath = wordNet.path;
  if (!fs.existsSync(wordNetPath)) {
    console.error(`WordNet files not found at ${wordNetPath}.`);
    process.exit(1);
  }

  const words = readLines(WORD_LIST_PATH)
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => /^[A-Z]+$/.test(entry));

  if (!words.length) {
    console.error(`No valid words found in ${WORD_LIST_PATH}.`);
    process.exit(1);
  }

  const glossesByPos = loadWordNetGlosses(wordNetPath);
  const lemmaDefinitions = loadLemmaDefinitions(wordNetPath, glossesByPos);
  const definitions = buildDefinitions(words, lemmaDefinitions);

  const coveredWords = Object.keys(definitions).length;
  const coveragePercent = Number(((coveredWords / words.length) * 100).toFixed(2));
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "Princeton WordNet 3.1 via wordnet-db",
    totalWords: words.length,
    coveredWords,
    coveragePercent,
    definitions
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const indexDetails = writeDefinitionIndexArtifacts(payload);
  console.log(
    `Wrote ${coveredWords}/${words.length} definitions (${coveragePercent}%) to ${OUTPUT_PATH}`
  );
  console.log(
    `Wrote indexed definition shards (${indexDetails.shardCount}) to ${indexDetails.outputDir}`
  );
}

main();
