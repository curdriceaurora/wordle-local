#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const {
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
const repoFullName = ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
const [repoOwner, repoName] = repoFullName.split("/");
const me = ghText(["api", "user", "--jq", ".login"]);

// Fetch via GraphQL `reviewThreads` so we can honor the `isResolved`
// flag set by the GitHub UI (or by us via `resolveReviewThread`). The
// older REST `/pulls/N/comments` endpoint omits this — meaning a
// bot-reviewer ack that resolves a thread in the UI looked
// "unresolved" to this script, and pr:nits flagged threads we had
// already finished with. See the follow-up task spawned from PR #109.
const GRAPHQL_QUERY = `
  query($owner: String!, $name: String!, $pr: Int!, $threadCursor: String, $commentCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 50, after: $threadCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 50, after: $commentCursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                databaseId
                author { login }
                path
                body
                createdAt
                line
                originalLine
                url
              }
            }
          }
        }
      }
    }
  }
`;

function fetchReviewThreads() {
  // Pagination: GitHub caps reviewThreads at 100/page. We use 50 to
  // stay well clear of the per-call point budget and paginate
  // explicitly. Comments-per-thread also paginate, but >50 comments
  // on one review thread is rare; if we ever hit it we'll see
  // hasNextPage=true and add inner pagination then. (Today no
  // observed thread exceeds 10 comments — round 3 of #106 was the
  // worst at 8.)
  const all = [];
  let cursor = null;
  let safetyCounter = 0;
  // Hard cap: 20 page fetches = up to 1000 review threads. A PR with
  // more review threads than that has bigger problems than this
  // script.
  while (safetyCounter < 20) {
    safetyCounter += 1;
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${GRAPHQL_QUERY}`,
      "-F",
      `owner=${repoOwner}`,
      "-F",
      `name=${repoName}`,
      "-F",
      `pr=${prNumber}`
    ];
    if (cursor) {
      args.push("-F", `threadCursor=${cursor}`);
    }
    const response = ghJson(args);
    const reviewThreads = response?.data?.repository?.pullRequest?.reviewThreads;
    if (!reviewThreads) break;
    all.push(...reviewThreads.nodes);
    if (!reviewThreads.pageInfo.hasNextPage) break;
    cursor = reviewThreads.pageInfo.endCursor;
  }
  return all;
}

// Normalize a GraphQL review-thread comment to the shape the
// existing helpers expect (REST-style `user.login`, `id`,
// `original_line`, `created_at`, `html_url`). Keeps
// `listActionableThreads` and `formatCommentSummary` callable
// without API changes.
function normalizeComment(comment) {
  return {
    id: comment.databaseId,
    user: comment.author ? { login: comment.author.login } : null,
    path: comment.path,
    body: comment.body,
    line: comment.line,
    original_line: comment.originalLine,
    html_url: comment.url,
    created_at: comment.createdAt
  };
}

function buildThreadsFromGraphQL(reviewThreadNodes) {
  // Output shape matches what `buildReviewThreads` produced for the
  // REST path: a Map keyed by root-comment databaseId, with values
  // `{ root, replies, isResolved }`. The isResolved field is new
  // and is consumed by `listActionableThreads` to filter out
  // already-resolved threads.
  const threads = new Map();
  for (const node of reviewThreadNodes) {
    const comments = node?.comments?.nodes;
    if (!Array.isArray(comments) || comments.length === 0) continue;
    const normalized = comments
      .slice()
      .sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      )
      .map(normalizeComment);
    const [root, ...replies] = normalized;
    threads.set(root.id, {
      root,
      replies,
      isResolved: Boolean(node.isResolved)
    });
  }
  return threads;
}

const reviewThreadNodes = fetchReviewThreads();
const threads = buildThreadsFromGraphQL(reviewThreadNodes);
const actionable = listActionableThreads(threads, me);

console.log(`PR #${prNumber} nit report for ${repoFullName}`);
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
