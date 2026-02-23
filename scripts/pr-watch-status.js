#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { formatCommentSummary } = require("./lib/pr-review-utils");

const STICKY_MARKER = "<!-- pr-watch-status -->";
const FAILURE_BLOCK_START = "<!-- pr-watch-error:start -->";
const FAILURE_BLOCK_END = "<!-- pr-watch-error:end -->";
const COPILOT_LOGIN_PREFIXES = Object.freeze([
  "copilot-pull-request-reviewer",
  "copilot"
]);
const COPILOT_TRIGGER_MARKER_REGEX = /<!--\s*copilot-auto-review sha:([a-f0-9]{40})\s*-->/i;
const COPILOT_HEAD_SHA_LINE_REGEX = /head sha:\s*([a-f0-9]{40})/i;
const MAX_THREADS_TO_SHOW = 10;

function nowIso() {
  return new Date().toISOString();
}

function splitRepo(fullRepo) {
  const [owner, repo] = String(fullRepo || "").split("/");
  if (!owner || !repo) {
    throw new Error("GITHUB_REPOSITORY must use format <owner>/<repo>.");
  }
  return { owner, repo };
}

function loadEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return {};
  }
  const fullPath = path.resolve(eventPath);
  if (!fs.existsSync(fullPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function escapeMarkdownText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}[\]()#+\-.!|>])/g, "\\$1")
    .replace(/\r?\n/g, " ");
}

function escapeTableCell(value) {
  return String(value || "")
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}

function normalizeLogin(login) {
  return String(login || "")
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/i, "");
}

function isCopilotAuthor(login) {
  const normalized = normalizeLogin(login);
  return COPILOT_LOGIN_PREFIXES.some((prefix) => (
    normalized === prefix || normalized.startsWith(`${prefix}-`)
  ));
}

function extractCopilotTriggerSha(commentBody) {
  const body = String(commentBody || "");
  if (!body.includes("/copilot review")) {
    return null;
  }
  const markerMatch = body.match(COPILOT_TRIGGER_MARKER_REGEX);
  if (markerMatch?.[1]) {
    return markerMatch[1].toLowerCase();
  }
  const lineMatch = body.match(COPILOT_HEAD_SHA_LINE_REGEX);
  if (lineMatch?.[1]) {
    return lineMatch[1].toLowerCase();
  }
  return null;
}

function hasCopilotTriggerForHeadSha(issueComments, headSha) {
  const normalizedHeadSha = String(headSha || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalizedHeadSha)) {
    return false;
  }
  return issueComments.some((comment) => (
    extractCopilotTriggerSha(comment?.body) === normalizedHeadSha
  ));
}

function hasCopilotRequestedReviewer(pr) {
  const reviewers = Array.isArray(pr?.requested_reviewers)
    ? pr.requested_reviewers
    : [];
  return reviewers.some((reviewer) => isCopilotAuthor(reviewer?.login || ""));
}

async function githubRequest(urlPath, options = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN/GH_TOKEN.");
  }

  const response = await fetch(`https://api.github.com${urlPath}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status} on ${urlPath}: ${text}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function githubGraphql(query, variables) {
  return githubRequest("/graphql", {
    method: "POST",
    body: { query, variables }
  });
}

async function paginateRest(urlBuilder, itemSelector) {
  const perPage = 100;
  const allItems = [];
  let page = 1;

  while (true) {
    const payload = await githubRequest(urlBuilder(page, perPage));
    const items = itemSelector(payload);
    if (!Array.isArray(items) || items.length === 0) {
      break;
    }

    allItems.push(...items);
    if (items.length < perPage) {
      break;
    }
    page += 1;
  }

  return allItems;
}

async function resolvePullRequestNumber(owner, repo, _eventName, payload) {
  if (payload?.pull_request?.number) {
    return Number(payload.pull_request.number);
  }
  if (payload?.issue?.pull_request && payload?.issue?.number) {
    return Number(payload.issue.number);
  }
  if (payload?.check_run?.pull_requests?.length) {
    return Number(payload.check_run.pull_requests[0].number);
  }
  if (payload?.check_suite?.pull_requests?.length) {
    return Number(payload.check_suite.pull_requests[0].number);
  }
  if (payload?.workflow_run?.pull_requests?.length) {
    return Number(payload.workflow_run.pull_requests[0].number);
  }

  const headSha = String(
    payload?.check_run?.head_sha ||
      payload?.check_suite?.head_sha ||
      payload?.workflow_run?.head_sha ||
      ""
  ).trim();
  if (!headSha) {
    return null;
  }

  const pulls = await githubRequest(`/repos/${owner}/${repo}/commits/${headSha}/pulls`);
  if (!Array.isArray(pulls) || !pulls.length) {
    return null;
  }
  return Number(pulls[0].number);
}

async function fetchPullRequest(owner, repo, prNumber) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`);
}

async function fetchIssueComments(owner, repo, prNumber) {
  return paginateRest(
    (page, perPage) =>
      `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`,
    (payload) => payload
  );
}

async function fetchCheckRuns(owner, repo, headSha) {
  return paginateRest(
    (page, perPage) =>
      `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=${perPage}&page=${page}`,
    (payload) => (Array.isArray(payload?.check_runs) ? payload.check_runs : [])
  );
}

function summarizeChecks(checkRuns) {
  const checks = checkRuns
    .filter((check) => String(check?.name || "").toLowerCase() !== "pr-watch")
    .map((check) => {
      const status = String(check.status || "");
      const conclusion = String(check.conclusion || "");
      let state = "pending";
      if (status === "completed") {
        state = ["success", "neutral", "skipped"].includes(conclusion) ? "pass" : "fail";
      }

      return {
        name: String(check.name || "Unnamed check"),
        state,
        status,
        conclusion: conclusion || "-"
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const hasFailure = checks.some((check) => check.state === "fail");
  const hasPending = checks.some((check) => check.state === "pending");
  const overall = hasFailure ? "fail" : hasPending ? "pending" : "pass";
  return { overall, checks };
}

async function fetchThreadAndReviewData(owner, repo, prNumber) {
  async function fetchAllThreads() {
    const query = `
      query($owner:String!, $repo:String!, $number:Int!, $after:String) {
        repository(owner:$owner, name:$repo) {
          pullRequest(number:$number) {
            reviewThreads(first:100, after:$after) {
              nodes {
                isResolved
                path
                line
                comments(last:1) {
                  nodes {
                    body
                    url
                    author { login }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `;

    const items = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const result = await githubGraphql(query, {
        owner,
        repo,
        number: prNumber,
        after: cursor
      });
      const payload = result?.data?.repository?.pullRequest?.reviewThreads;
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
      items.push(...nodes);
      hasNextPage = Boolean(payload?.pageInfo?.hasNextPage);
      cursor = payload?.pageInfo?.endCursor || null;
    }

    return items;
  }

  async function fetchAllReviews() {
    const query = `
      query($owner:String!, $repo:String!, $number:Int!, $after:String) {
        repository(owner:$owner, name:$repo) {
          pullRequest(number:$number) {
            reviews(first:100, after:$after) {
              nodes {
                state
                submittedAt
                author { login }
                commit { oid }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `;

    const items = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const result = await githubGraphql(query, {
        owner,
        repo,
        number: prNumber,
        after: cursor
      });
      const payload = result?.data?.repository?.pullRequest?.reviews;
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
      items.push(...nodes);
      hasNextPage = Boolean(payload?.pageInfo?.hasNextPage);
      cursor = payload?.pageInfo?.endCursor || null;
    }

    return items;
  }

  const [rawThreads, reviews] = await Promise.all([fetchAllThreads(), fetchAllReviews()]);
  const unresolvedThreads = rawThreads
    .filter((thread) => !thread.isResolved)
    .map((thread) => {
      const latest = thread?.comments?.nodes?.[0] || {};
      return {
        path: thread.path || "(general)",
        line: thread.line || "-",
        author: latest?.author?.login || "unknown",
        summary: formatCommentSummary(latest?.body || ""),
        url: latest?.url || ""
      };
    });

  return { unresolvedThreads, reviews };
}

function summarizeCopilotReview(reviews, headSha, options = {}) {
  const copilotReviews = reviews.filter((review) => isCopilotAuthor(review?.author?.login || ""));
  const hasCurrent = copilotReviews.some(
    (review) =>
      String(review?.commit?.oid || "") === headSha &&
      ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(String(review?.state || ""))
  );
  if (hasCurrent) {
    return "completed";
  }

  if (options.hasCurrentTrigger || options.hasRequestedReviewer) {
    return "pending";
  }

  if (copilotReviews.length) {
    return "outdated";
  }

  return "not-requested";
}

function summarizeCopilotTriggerSignal(options = {}) {
  if (options.hasCurrentTrigger && options.hasRequestedReviewer) {
    return "comment+reviewer";
  }
  if (options.hasCurrentTrigger) {
    return "comment";
  }
  if (options.hasRequestedReviewer) {
    return "reviewer";
  }
  return "none";
}

function statusIcon(state) {
  if (state === "pass") return "✅";
  if (state === "fail") return "❌";
  if (state === "completed") return "✅";
  if (state === "not-requested") return "⚪";
  if (state === "outdated") return "⚠️";
  return "⏳";
}

function buildStatusComment(payload) {
  const unresolvedCopilot = payload.unresolvedThreads.filter((thread) =>
    isCopilotAuthor(thread.author || "")
  );
  const unresolvedHuman = payload.unresolvedThreads.filter(
    (thread) => !isCopilotAuthor(thread.author || "")
  );

  const checksTableRows = payload.checkSummary.checks.length
    ? payload.checkSummary.checks
        .map(
          (check) =>
            `| ${statusIcon(check.state)} | ${escapeTableCell(check.name)} | ${escapeTableCell(check.status)} | ${escapeTableCell(check.conclusion)} |`
        )
        .join("\n")
    : "| ⏳ | No checks yet | pending | - |";

  let openThreadLines = "- None";
  if (payload.unresolvedThreads.length) {
    const lines = payload.unresolvedThreads.slice(0, MAX_THREADS_TO_SHOW).map((thread) => {
      const author = escapeMarkdownText(thread.author || "unknown");
      const location = `${escapeMarkdownText(thread.path)}:${escapeMarkdownText(thread.line)}`;
      const summary = escapeMarkdownText(thread.summary || "");
      if (thread.url) {
        return `- [${author}](${thread.url}) \`${location}\` — ${summary}`;
      }
      return `- ${author} \`${location}\` — ${summary}`;
    });
    const remaining = payload.unresolvedThreads.length - MAX_THREADS_TO_SHOW;
    if (remaining > 0) {
      lines.push(`- (+${remaining} more unresolved thread${remaining === 1 ? "" : "s"} not shown)`);
    }
    openThreadLines = lines.join("\n");
  }

  return [
    STICKY_MARKER,
    "## PR Watch Status",
    "",
    `- PR: #${payload.prNumber} — ${escapeMarkdownText(payload.prTitle)}`,
    `- Head SHA: \`${escapeMarkdownText(payload.headSha)}\``,
    `- CI Overall: ${statusIcon(payload.checkSummary.overall)} \`${payload.checkSummary.overall}\``,
    `- Copilot Review: ${statusIcon(payload.copilotStatus)} \`${payload.copilotStatus}\``,
    `- Copilot Trigger Signal: ${statusIcon(payload.copilotTriggerSignal === "none" ? "not-requested" : "pending")} \`${payload.copilotTriggerSignal}\``,
    `- Open Threads: ${payload.unresolvedThreads.length} (Copilot: ${unresolvedCopilot.length}, Human: ${unresolvedHuman.length})`,
    "",
    "### Checks",
    "| Status | Check | State | Conclusion |",
    "| --- | --- | --- | --- |",
    checksTableRows,
    "",
    "### Open Review Threads",
    openThreadLines,
    "",
    `Last updated: ${nowIso()}`
  ].join("\n");
}

function upsertFailureBlock(existingBody, message) {
  const note = [
    FAILURE_BLOCK_START,
    `- Monitor note: ${escapeMarkdownText(message)}`,
    `- Timestamp: ${nowIso()}`,
    FAILURE_BLOCK_END
  ].join("\n");

  const regex = new RegExp(`${FAILURE_BLOCK_START}[\\s\\S]*?${FAILURE_BLOCK_END}`);
  if (regex.test(existingBody)) {
    return existingBody.replace(regex, note);
  }
  return `${existingBody.trim()}\n\n${note}\n`;
}

async function upsertStickyComment(owner, repo, prNumber, body) {
  const comments = await fetchIssueComments(owner, repo, prNumber);
  const existing = comments.find((comment) => String(comment.body || "").includes(STICKY_MARKER));
  if (existing) {
    await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: { body }
    });
    return;
  }

  await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: { body }
  });
}

async function annotateFailure(owner, repo, prNumber, message) {
  if (!prNumber) {
    return;
  }
  try {
    const comments = await fetchIssueComments(owner, repo, prNumber);
    const existing = comments.find((comment) => String(comment.body || "").includes(STICKY_MARKER));
    if (existing) {
      const patchedBody = upsertFailureBlock(String(existing.body || ""), message);
      await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        body: { body: patchedBody }
      });
      return;
    }

    await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      body: {
        body: `${STICKY_MARKER}\n## PR Watch Status\n\n${FAILURE_BLOCK_START}\n- Monitor note: ${escapeMarkdownText(message)}\n- Timestamp: ${nowIso()}\n${FAILURE_BLOCK_END}\n`
      }
    });
  } catch (err) {
    console.error("pr-watch fallback annotation failed:", err.message);
  }
}

async function main() {
  const { owner, repo } = splitRepo(process.env.GITHUB_REPOSITORY || "");
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const payload = loadEventPayload();

  let prNumber = null;
  try {
    prNumber = await resolvePullRequestNumber(owner, repo, eventName, payload);
    if (!prNumber) {
      console.log(`No PR context detected for event '${eventName}'. Exiting.`);
      return;
    }

    const pr = await fetchPullRequest(owner, repo, prNumber);
    const headSha = String(pr?.head?.sha || "").trim().toLowerCase();
    if (!headSha) {
      throw new Error(`PR #${prNumber} has no head SHA.`);
    }

    const [checkRuns, threadData, issueComments] = await Promise.all([
      fetchCheckRuns(owner, repo, headSha),
      fetchThreadAndReviewData(owner, repo, prNumber),
      fetchIssueComments(owner, repo, prNumber)
    ]);
    const checkSummary = summarizeChecks(checkRuns);
    const hasCurrentTrigger = hasCopilotTriggerForHeadSha(issueComments, headSha);
    const hasRequestedReviewer = hasCopilotRequestedReviewer(pr);
    const copilotStatus = summarizeCopilotReview(threadData.reviews, headSha, {
      hasCurrentTrigger,
      hasRequestedReviewer
    });
    const copilotTriggerSignal = summarizeCopilotTriggerSignal({
      hasCurrentTrigger,
      hasRequestedReviewer
    });

    const body = buildStatusComment({
      prNumber,
      prTitle: String(pr?.title || "Untitled PR"),
      headSha,
      checkSummary,
      copilotStatus,
      copilotTriggerSignal,
      unresolvedThreads: threadData.unresolvedThreads
    });

    await upsertStickyComment(owner, repo, prNumber, body);
    console.log(`Updated PR watch status comment for PR #${prNumber}.`);
  } catch (err) {
    const message = String(err?.message || err || "Unknown error");
    console.error(`pr-watch-status error: ${message}`);
    await annotateFailure(owner, repo, prNumber, message);
  }
}

main().catch((err) => {
  console.error("Unexpected pr-watch-status failure:", err);
  process.exit(0);
});
