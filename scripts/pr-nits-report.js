#!/usr/bin/env node

const { execFileSync } = require("node:child_process");

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

function formatLine(comment) {
  const body = String(comment.body || "").replace(/\s+/g, " ").trim();
  return body.length > 160 ? `${body.slice(0, 157)}...` : body;
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

const threads = new Map();

comments.forEach((comment) => {
  if (comment.in_reply_to_id) {
    const root = threads.get(comment.in_reply_to_id);
    if (root) {
      root.replies.push(comment);
    }
    return;
  }
  threads.set(comment.id, { root: comment, replies: [] });
});

const actionable = [];
threads.forEach(({ root, replies }) => {
  const threadComments = [root, ...replies].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const latest = threadComments[threadComments.length - 1];
  const isBot = String(root.user?.login || "").includes("[bot]");
  const needsReply = latest.user?.login !== me;
  if (needsReply) {
    actionable.push({
      id: root.id,
      author: root.user?.login || "unknown",
      path: root.path || "(general)",
      line: root.original_line || root.line || "-",
      isBot,
      url: root.html_url,
      summary: formatLine(root)
    });
  }
});

actionable.sort((a, b) => {
  if (a.isBot !== b.isBot) return a.isBot ? -1 : 1;
  return a.path.localeCompare(b.path);
});

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
