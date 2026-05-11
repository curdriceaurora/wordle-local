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
// First-page query: fetch a page of review threads, each with up to
// 50 comments + a hasNextPage flag for the inner comment connection.
// If any thread reports hasNextPage=true we follow up with
// THREAD_COMMENTS_QUERY against that thread's relay `id`. This pattern
// — separate outer + inner pagination queries — keeps the code linear
// and avoids the complexity of nested cursors in a single query that
// only paginates one connection at a time anyway. Codex + Copilot
// flagged the missing inner pagination on PR #110.
const THREADS_QUERY = `
  query($owner: String!, $name: String!, $pr: Int!, $threadCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 50, after: $threadCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 50) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
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

// Inner pagination for one specific thread's comment connection. The
// outer query handed us the thread's relay `id`; we request additional
// comment pages until hasNextPage is false.
const THREAD_COMMENTS_QUERY = `
  query($threadId: ID!, $commentCursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 50, after: $commentCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
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
`;

function fetchAdditionalThreadComments(threadId) {
  // Called when an outer-query thread reported comments.pageInfo.hasNextPage.
  // Returns the FULL list of comments past the first 50.
  const extra = [];
  let cursor = null;
  let safety = 0;
  // 20 inner pages × 50 comments = 1000 comments per thread. Anything
  // beyond that exits the loop to avoid runaway paging.
  while (safety < 20) {
    safety += 1;
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${THREAD_COMMENTS_QUERY}`,
      "-F",
      `threadId=${threadId}`
    ];
    if (cursor) {
      args.push("-F", `commentCursor=${cursor}`);
    }
    const response = ghJson(args);
    const conn = response?.data?.node?.comments;
    if (!conn) break;
    extra.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return extra;
}

function fetchReviewThreads() {
  // Outer pagination: GitHub caps reviewThreads at 100/page. We use 50.
  // For each thread, if the inner comments connection has more pages,
  // call fetchAdditionalThreadComments() to follow them — otherwise
  // the latest-commenter check could read stale data and pr:nits would
  // miss the most recent reply.
  const all = [];
  let cursor = null;
  let safety = 0;
  // Hard cap: 20 outer pages = up to 1000 review threads. A PR with
  // more review threads than that has bigger problems than this script.
  while (safety < 20) {
    safety += 1;
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${THREADS_QUERY}`,
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

    // For each thread on this outer page, fill in any missing comments
    // via the inner-pagination follow-up. Mutating each node so the
    // caller sees one complete tree.
    for (const node of reviewThreads.nodes) {
      const inner = node?.comments;
      if (inner?.pageInfo?.hasNextPage && node?.id) {
        const extra = fetchAdditionalThreadComments(node.id);
        inner.nodes = [...(inner.nodes || []), ...extra];
        inner.pageInfo.hasNextPage = false;
      }
    }

    all.push(...reviewThreads.nodes);
    if (!reviewThreads.pageInfo.hasNextPage) break;
    cursor = reviewThreads.pageInfo.endCursor;
  }
  return all;
}

// Normalize a GraphQL review-thread comment to the shape the existing
// helpers expect (REST-style `user.login`, `id`, `original_line`,
// `created_at`, `html_url`). Keeps `listActionableThreads` and
// `formatCommentSummary` callable without API changes.
//
// `id` falls back from databaseId (the historical REST int id) to the
// relay `id` (always non-null) when GitHub returns null for databaseId.
// Copilot flagged the unguarded databaseId on PR #110 — in practice
// every real comment has a non-null databaseId, but defensive default
// is cheap.
function normalizeComment(comment) {
  return {
    id: comment.databaseId ?? comment.id ?? null,
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
  // REST path: a Map with `{ root, replies, isResolved }` values. The
  // KEY is now the thread's relay `id` (always non-null), not the
  // root comment's databaseId — the latter is technically nullable
  // in GitHub's schema and would risk collapsing multiple threads
  // under a `null` key. Codex/Copilot caught this on PR #110.
  const threads = new Map();
  for (const node of reviewThreadNodes) {
    const comments = node?.comments?.nodes;
    if (!Array.isArray(comments) || comments.length === 0) continue;
    if (!node.id) continue; // defensive — relay id should always exist
    const normalized = comments
      .slice()
      .sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      )
      .map(normalizeComment);
    const [root, ...replies] = normalized;
    threads.set(node.id, {
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
