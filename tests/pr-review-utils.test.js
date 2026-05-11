"use strict";

// Unit tests for scripts/lib/pr-review-utils.js.
//
// Spawned from PR #109 follow-up: the previous implementation only
// checked "is the latest commenter me?" and missed GitHub's
// `isResolved` flag, causing pr:nits to flag threads that had
// already been resolved by a bot reviewer's ack. These tests pin
// the filtering contract.

const {
  buildReviewThreads,
  listActionableThreads
} = require("../scripts/lib/pr-review-utils");

function comment({ id, replyTo = null, login, createdAt, body = "" }) {
  return {
    id,
    in_reply_to_id: replyTo,
    user: { login },
    body,
    path: "tests/example.test.js",
    line: 10,
    original_line: 10,
    html_url: `https://github.com/example/repo/pull/1#discussion_r${id}`,
    created_at: createdAt
  };
}

describe("listActionableThreads: latest-commenter filter (legacy REST behavior)", () => {
  test("flags threads where the latest commenter is NOT the viewer", () => {
    const threads = buildReviewThreads([
      comment({ id: 1, login: "bot", createdAt: "2026-05-10T10:00:00Z" }),
      comment({ id: 2, replyTo: 1, login: "viewer", createdAt: "2026-05-10T10:05:00Z" }),
      comment({ id: 3, replyTo: 1, login: "bot", createdAt: "2026-05-10T10:10:00Z" })
    ]);
    const actionable = listActionableThreads(threads, "viewer");
    expect(actionable).toHaveLength(1);
    expect(actionable[0].author).toBe("bot");
  });

  test("skips threads where the viewer is the latest commenter", () => {
    const threads = buildReviewThreads([
      comment({ id: 1, login: "bot", createdAt: "2026-05-10T10:00:00Z" }),
      comment({ id: 2, replyTo: 1, login: "viewer", createdAt: "2026-05-10T10:05:00Z" })
    ]);
    expect(listActionableThreads(threads, "viewer")).toEqual([]);
  });

  test("REST input without isResolved still flags (backward compat)", () => {
    // buildReviewThreads produces entries without isResolved. The
    // listActionableThreads filter must treat missing/undefined
    // isResolved as falsy → continue to legacy behavior.
    const threads = buildReviewThreads([
      comment({ id: 1, login: "bot", createdAt: "2026-05-10T10:00:00Z" })
    ]);
    expect(threads.get(1).isResolved).toBeUndefined();
    const actionable = listActionableThreads(threads, "viewer");
    expect(actionable).toHaveLength(1);
  });
});

describe("listActionableThreads: isResolved filter (new GraphQL behavior)", () => {
  function graphqlThread({ rootId, comments, isResolved }) {
    const sorted = [...comments].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const [root, ...replies] = sorted;
    return { rootId, value: { root, replies, isResolved } };
  }

  function buildMap(threadList) {
    const map = new Map();
    for (const t of threadList) map.set(t.rootId, t.value);
    return map;
  }

  test("skips threads with isResolved=true even when the latest commenter is a bot", () => {
    // Real-world example: CodeRabbit replies "thanks for the fix"
    // and marks the thread resolved in the UI. Before this fix
    // pr:nits flagged it; after, the GraphQL response carries
    // isResolved=true and listActionableThreads skips it.
    const threads = buildMap([
      graphqlThread({
        rootId: 1,
        isResolved: true,
        comments: [
          comment({ id: 1, login: "bot", createdAt: "2026-05-10T10:00:00Z" }),
          comment({ id: 2, replyTo: 1, login: "viewer", createdAt: "2026-05-10T10:05:00Z", body: "Addressed in abc123" }),
          comment({ id: 3, replyTo: 1, login: "bot", createdAt: "2026-05-10T10:10:00Z", body: "Confirmed — good fix" })
        ]
      })
    ]);
    expect(listActionableThreads(threads, "viewer")).toEqual([]);
  });

  test("isResolved=false threads still flagged by latest-commenter rule", () => {
    const threads = buildMap([
      graphqlThread({
        rootId: 1,
        isResolved: false,
        comments: [
          comment({ id: 1, login: "bot", createdAt: "2026-05-10T10:00:00Z" })
        ]
      })
    ]);
    const actionable = listActionableThreads(threads, "viewer");
    expect(actionable).toHaveLength(1);
    expect(actionable[0].author).toBe("bot");
  });

  test("isResolved=false but viewer is latest → still skipped (legacy rule applies)", () => {
    const threads = buildMap([
      graphqlThread({
        rootId: 1,
        isResolved: false,
        comments: [
          comment({ id: 1, login: "bot", createdAt: "2026-05-10T10:00:00Z" }),
          comment({ id: 2, replyTo: 1, login: "viewer", createdAt: "2026-05-10T10:05:00Z" })
        ]
      })
    ]);
    expect(listActionableThreads(threads, "viewer")).toEqual([]);
  });

  test("mixed thread set: only the unresolved bot-latest one is flagged", () => {
    const threads = buildMap([
      graphqlThread({
        rootId: 1,
        isResolved: true,
        comments: [comment({ id: 1, login: "bot", createdAt: "2026-05-10T10:00:00Z" })]
      }),
      graphqlThread({
        rootId: 2,
        isResolved: false,
        comments: [comment({ id: 2, login: "bot", createdAt: "2026-05-10T10:00:00Z" })]
      }),
      graphqlThread({
        rootId: 3,
        isResolved: false,
        comments: [
          comment({ id: 3, login: "bot", createdAt: "2026-05-10T10:00:00Z" }),
          comment({ id: 4, replyTo: 3, login: "viewer", createdAt: "2026-05-10T10:05:00Z" })
        ]
      })
    ]);
    const actionable = listActionableThreads(threads, "viewer");
    expect(actionable).toHaveLength(1);
    expect(actionable[0].id).toBe(2);
  });
});
