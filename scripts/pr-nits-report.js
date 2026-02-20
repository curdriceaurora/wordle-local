#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const {
  buildReviewThreads,
  listActionableThreads
} = require("./lib/pr-review-utils");

function readFlag(name) {
  const direct = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) {
    return direct.slice(name.length + 3).trim();
  }

  const flagIndex = process.argv.findIndex((arg) => arg === `--${name}`);
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) {
    return String(process.argv[flagIndex + 1]).trim();
  }

  return "";
}

function ghJson(args) {
  const output = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(output);
}

function ghText(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function usageAndExit() {
  console.error("Usage: node scripts/pr-nits-report.js --pr <number>");
  process.exit(1);
}

const prRaw = readFlag("pr");
if (!prRaw || !/^\d+$/.test(prRaw)) {
  usageAndExit();
}

const prNumber = Number(prRaw);
const repo = ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
const me = ghText(["api", "user", "--jq", ".login"]);

const comments = ghJson([
  "api",
  `repos/${repo}/pulls/${prNumber}/comments`,
  "--paginate"
]);

const threads = buildReviewThreads(comments);
const actionable = listActionableThreads(threads, me);

console.log(`PR #${prNumber} nit report for ${repo}`);
console.log(`Open threads requiring repo-owner response: ${actionable.length}`);

if (!actionable.length) {
  process.exit(0);
}

actionable.forEach((item, index) => {
  console.log("");
  console.log(`${index + 1}. ${item.author} ${item.path}:${item.line}`);
  console.log(`   ${item.summary}`);
  console.log(`   ${item.url}`);
});
