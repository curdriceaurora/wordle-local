#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { formatCommentSummary } = require("./lib/pr-review-utils");

const STICKY_MARKER = "<!-- pr-watch-status -->";
const FAILURE_BLOCK_START = "<!-- pr-watch-error:start -->";
const FAILURE_BLOCK_END = "<!-- pr-watch-error:end -->";

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

async function githubRequest(urlPath, options = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN/GH_TOKEN.");
  }
  const baseUrl = "https://api.github.com";
  const response = await fetch(`${baseUrl}${urlPath}`, {
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

async function resolvePullRequestNumber(owner, repo, eventName, payload) {
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
  return githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);
}

async function fetchCheckRuns(owner, repo, headSha) {
  const payload = await githubRequest(
    `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`
  );
  return Array.isArray(payload?.check_runs) ? payload.check_runs : [];
}

function summarizeChecks(checkRuns) {
  const checks = checkRuns
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
  const query = `
    query($owner:String!, $repo:String!, $number:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          reviewThreads(first:100) {
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
          }
          reviews(last:100) {
            nodes {
              state
              submittedAt
              author { login }
              commit { oid }
            }
          }
        }
      }
    }
  `;

  const result = await githubGraphql(query, {
    owner,
    repo,
    number: prNumber
  });

  const pullRequest = result?.data?.repository?.pullRequest;
  const rawThreads = pullRequest?.reviewThreads?.nodes || [];
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

  const reviews = Array.isArray(pullRequest?.reviews?.nodes)
    ? pullRequest.reviews.nodes
    : [];
  return { unresolvedThreads, reviews };
}

function summarizeCopilotReview(reviews, headSha) {
  const copilotReviews = reviews.filter(
    (review) => String(review?.author?.login || "") === "copilot-pull-request-reviewer"
  );
  if (!copilotReviews.length) {
    return "pending";
  }

  const hasCurrent = copilotReviews.some(
    (review) =>
      String(review?.commit?.oid || "") === headSha &&
      ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(String(review?.state || ""))
  );
  if (hasCurrent) {
    return "completed";
  }
  return "outdated";
}

function statusIcon(state) {
  if (state === "pass") return "✅";
  if (state === "fail") return "❌";
  if (state === "completed") return "✅";
  if (state === "outdated") return "⚠️";
  return "⏳";
}

function buildStatusComment(payload) {
  const unresolvedCopilot = payload.unresolvedThreads.filter((thread) =>
    String(thread.author || "").includes("copilot")
  );
  const unresolvedHuman = payload.unresolvedThreads.filter(
    (thread) => !String(thread.author || "").includes("copilot")
  );

  const checksTableRows = payload.checkSummary.checks.length
    ? payload.checkSummary.checks
        .map(
          (check) =>
            `| ${statusIcon(check.state)} | \`${check.name}\` | \`${check.status}\` | \`${check.conclusion}\` |`
        )
        .join("\n")
    : "| ⏳ | `No checks yet` | `pending` | `-` |";

  const openThreadLines = payload.unresolvedThreads.length
    ? payload.unresolvedThreads
        .slice(0, 10)
        .map(
          (thread) =>
            `- [${thread.author}](${thread.url}) \`${thread.path}:${thread.line}\` — ${thread.summary}`
        )
        .join("\n")
    : "- None";

  return [
    STICKY_MARKER,
    "## PR Watch Status",
    "",
    `- PR: #${payload.prNumber} — ${payload.prTitle}`,
    `- Head SHA: \`${payload.headSha}\``,
    `- CI Overall: ${statusIcon(payload.checkSummary.overall)} \`${payload.checkSummary.overall}\``,
    `- Copilot Review: ${statusIcon(payload.copilotStatus)} \`${payload.copilotStatus}\``,
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
    `- Monitor note: ${message}`,
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
        body: `${STICKY_MARKER}\n## PR Watch Status\n\n${FAILURE_BLOCK_START}\n- Monitor note: ${message}\n- Timestamp: ${nowIso()}\n${FAILURE_BLOCK_END}\n`
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
    const headSha = String(pr?.head?.sha || "").trim();
    if (!headSha) {
      throw new Error(`PR #${prNumber} has no head SHA.`);
    }

    const [checkRuns, threadData] = await Promise.all([
      fetchCheckRuns(owner, repo, headSha),
      fetchThreadAndReviewData(owner, repo, prNumber)
    ]);
    const checkSummary = summarizeChecks(checkRuns);
    const copilotStatus = summarizeCopilotReview(threadData.reviews, headSha);

    const body = buildStatusComment({
      prNumber,
      prTitle: String(pr?.title || "Untitled PR"),
      headSha,
      checkSummary,
      copilotStatus,
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
