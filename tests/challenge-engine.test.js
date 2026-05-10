"use strict";

const {
  computeScore,
  computeRemainingSeconds,
  hasTimedOut,
  projectSessionForPlayer,
  buildLeaderboard,
  checkReplayAllowed
} = require("../lib/challenge-engine");

const baseChallenge = {
  id: "c1",
  name: "Test",
  lang: "en",
  puzzleCount: 3,
  timeBudgetSeconds: 300,
  maxGuesses: 6,
  perPuzzleScore: 1000,
  speedBonusFactor: 5,
  replayPolicy: "best"
};

// Minimal stand-in for server.js evaluateGuess. Returns one entry per
// letter: "correct" | "present" | "absent". The full evaluator is
// tested elsewhere; this mock is enough to exercise the projection.
function fakeEvaluate(guess, answer) {
  const len = answer.length;
  const result = new Array(len);
  const remaining = {};
  for (let i = 0; i < len; i++) {
    if (guess[i] === answer[i]) result[i] = "correct";
    else {
      result[i] = "absent";
      remaining[answer[i]] = (remaining[answer[i]] || 0) + 1;
    }
  }
  for (let i = 0; i < len; i++) {
    if (result[i] === "correct") continue;
    if (remaining[guess[i]] > 0) {
      result[i] = "present";
      remaining[guess[i]] -= 1;
    }
  }
  return result;
}

function makeSession(overrides = {}) {
  return {
    id: "s1",
    challengeId: "c1",
    profileId: "p1",
    profileName: "Alice",
    status: "in-progress",
    startedAt: new Date(2026, 4, 9, 12, 0, 0).toISOString(),
    puzzles: [
      { index: 0, word: "CRANE", guesses: [], solved: false },
      { index: 1, word: "BREAD", guesses: [], solved: false },
      { index: 2, word: "STORM", guesses: [], solved: false }
    ],
    ...overrides
  };
}

describe("computeScore", () => {
  test("sum of per-puzzle base scores plus time bonus", () => {
    const score = computeScore({
      challenge: baseChallenge,
      puzzles: [
        { solved: true }, { solved: true }, { solved: true }
      ],
      elapsedSeconds: 100
    });
    // 3 * 1000 + (300 - 100) * 5 = 3000 + 1000 = 4000
    expect(score).toBe(4000);
  });

  test("unsolved puzzles contribute 0", () => {
    const score = computeScore({
      challenge: baseChallenge,
      puzzles: [{ solved: false }, { solved: false }, { solved: false }],
      elapsedSeconds: 100
    });
    // No base; bonus = (300-100)*5 = 1000
    expect(score).toBe(1000);
  });

  test("over-budget elapsed clamps the bonus to zero", () => {
    const score = computeScore({
      challenge: baseChallenge,
      puzzles: [{ solved: true }],
      elapsedSeconds: 99999
    });
    expect(score).toBe(1000); // base only
  });

  test("integer floor — fractional bonus doesn't leak", () => {
    const score = computeScore({
      challenge: { ...baseChallenge, speedBonusFactor: 0.7 },
      puzzles: [{ solved: true }],
      elapsedSeconds: 100
    });
    // 1000 + 200 * 0.7 = 1140
    expect(score).toBe(1140);
  });

  test("missing arrays / undefined challenge throws", () => {
    expect(() => computeScore({})).toThrow();
    expect(() => computeScore({ challenge: baseChallenge })).toThrow();
  });
});

describe("computeRemainingSeconds + hasTimedOut", () => {
  test("returns full budget at startedAt", () => {
    const session = makeSession();
    const now = new Date(Date.parse(session.startedAt));
    expect(computeRemainingSeconds({ session, challenge: baseChallenge, now })).toBe(300);
    expect(hasTimedOut({ session, challenge: baseChallenge, now })).toBe(false);
  });

  test("returns 0 when budget exhausted", () => {
    const session = makeSession();
    const now = new Date(Date.parse(session.startedAt) + 301_000);
    expect(computeRemainingSeconds({ session, challenge: baseChallenge, now })).toBe(0);
    expect(hasTimedOut({ session, challenge: baseChallenge, now })).toBe(true);
  });

  test("never returns negative", () => {
    const session = makeSession();
    const now = new Date(Date.parse(session.startedAt) + 9999_000);
    expect(computeRemainingSeconds({ session, challenge: baseChallenge, now })).toBe(0);
  });
});

describe("projectSessionForPlayer (anti-cheat: hide unsolved words)", () => {
  test("active puzzle word is HIDDEN", () => {
    const session = makeSession();
    const projected = projectSessionForPlayer({ session, challenge: baseChallenge, evaluateGuess: fakeEvaluate });
    expect(projected.puzzles[0].word).toBeUndefined();
    expect(projected.puzzles[1].word).toBeUndefined();
    expect(projected.puzzles[2].word).toBeUndefined();
  });

  test("solved puzzles reveal their word", () => {
    const session = makeSession({
      puzzles: [
        { index: 0, word: "CRANE", guesses: ["CRANE"], solved: true },
        { index: 1, word: "BREAD", guesses: [], solved: false },
        { index: 2, word: "STORM", guesses: [], solved: false }
      ]
    });
    const projected = projectSessionForPlayer({ session, challenge: baseChallenge, evaluateGuess: fakeEvaluate });
    expect(projected.puzzles[0].word).toBe("CRANE");
    expect(projected.puzzles[1].word).toBeUndefined();
    expect(projected.puzzles[2].word).toBeUndefined();
  });

  test("exhausted-guesses puzzle reveals its word", () => {
    const session = makeSession({
      puzzles: [
        {
          index: 0, word: "CRANE",
          guesses: ["SLATE", "BREAD", "PRIDE", "GLAZE", "MIGHT", "LATER"],
          solved: false
        },
        { index: 1, word: "BREAD", guesses: [], solved: false },
        { index: 2, word: "STORM", guesses: [], solved: false }
      ]
    });
    const projected = projectSessionForPlayer({ session, challenge: baseChallenge, evaluateGuess: fakeEvaluate });
    expect(projected.puzzles[0].word).toBe("CRANE"); // exhausted, revealed
    expect(projected.puzzles[1].word).toBeUndefined(); // active, hidden
    expect(projected.puzzles[2].word).toBeUndefined(); // not yet active, hidden
  });

  test("terminal session reveals all words", () => {
    const session = makeSession({ status: "completed" });
    const projected = projectSessionForPlayer({ session, challenge: baseChallenge, evaluateGuess: fakeEvaluate });
    expect(projected.puzzles[0].word).toBe("CRANE");
    expect(projected.puzzles[1].word).toBe("BREAD");
    expect(projected.puzzles[2].word).toBe("STORM");
    expect(projected.remainingSeconds).toBe(0);
  });

  test("projection includes per-letter feedbacks for every historical guess", () => {
    const session = makeSession({
      puzzles: [
        {
          index: 0, word: "CRANE",
          guesses: ["SLATE", "CRANE"],
          solved: true
        },
        { index: 1, word: "BREAD", guesses: [], solved: false },
        { index: 2, word: "STORM", guesses: [], solved: false }
      ]
    });
    const projected = projectSessionForPlayer({
      session, challenge: baseChallenge, evaluateGuess: fakeEvaluate
    });
    const p0 = projected.puzzles[0];
    expect(Array.isArray(p0.feedbacks)).toBe(true);
    expect(p0.feedbacks).toHaveLength(2);
    // SLATE vs CRANE: S=absent, L=absent, A=correct, T=absent, E=correct
    expect(p0.feedbacks[0]).toEqual(["absent", "absent", "correct", "absent", "correct"]);
    // CRANE vs CRANE: all correct
    expect(p0.feedbacks[1]).toEqual(["correct", "correct", "correct", "correct", "correct"]);
    // Empty puzzles → empty feedbacks
    expect(projected.puzzles[1].feedbacks).toEqual([]);
    expect(projected.puzzles[2].feedbacks).toEqual([]);
  });

  test("projection requires evaluateGuess and throws otherwise", () => {
    expect(() => projectSessionForPlayer({
      session: makeSession(), challenge: baseChallenge
    })).toThrow();
  });

  test("activePuzzleIndex tracks first unfinished puzzle", () => {
    const session = makeSession({
      puzzles: [
        { index: 0, word: "CRANE", guesses: ["CRANE"], solved: true },
        { index: 1, word: "BREAD", guesses: [], solved: false },
        { index: 2, word: "STORM", guesses: [], solved: false }
      ]
    });
    const projected = projectSessionForPlayer({ session, challenge: baseChallenge, evaluateGuess: fakeEvaluate });
    expect(projected.activePuzzleIndex).toBe(1);
  });
});

describe("buildLeaderboard", () => {
  function makeCompletedSession({ profileId, score, elapsedSeconds, finishedAt, profileName }) {
    return {
      id: `s-${profileId}-${score}`,
      challengeId: "c1",
      profileId,
      profileName,
      status: "completed",
      startedAt: new Date(2026, 4, 9, 12, 0, 0).toISOString(),
      finishedAt,
      score,
      elapsedSeconds,
      puzzles: [{ index: 0, word: "CRANE", guesses: ["CRANE"], solved: true }]
    };
  }

  test("best policy: one row per profile, highest score wins", () => {
    const sessions = [
      makeCompletedSession({ profileId: "p1", score: 1000, elapsedSeconds: 100, finishedAt: "2026-05-09T12:01:40Z" }),
      makeCompletedSession({ profileId: "p1", score: 2000, elapsedSeconds: 80, finishedAt: "2026-05-09T13:01:20Z" }),
      makeCompletedSession({ profileId: "p2", score: 1500, elapsedSeconds: 90, finishedAt: "2026-05-09T12:01:30Z" })
    ];
    const rows = buildLeaderboard({ challenge: baseChallenge, sessions });
    expect(rows).toHaveLength(2);
    expect(rows[0].profileId).toBe("p1");
    expect(rows[0].score).toBe(2000);
    expect(rows[1].profileId).toBe("p2");
  });

  test("first-only policy: only the first session per profile counts", () => {
    const challenge = { ...baseChallenge, replayPolicy: "first-only" };
    const sessions = [
      makeCompletedSession({
        profileId: "p1", score: 500, elapsedSeconds: 120,
        finishedAt: "2026-05-09T12:02:00Z"
      }),
      // Second session for p1 - HIGHER score, but later: ignored.
      {
        ...makeCompletedSession({
          profileId: "p1", score: 9999, elapsedSeconds: 60,
          finishedAt: "2026-05-09T13:01:00Z"
        }),
        startedAt: new Date(2026, 4, 9, 13, 0, 0).toISOString()
      }
    ];
    const rows = buildLeaderboard({ challenge, sessions });
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(500);
  });

  test("unlimited policy: all sessions appear", () => {
    const challenge = { ...baseChallenge, replayPolicy: "unlimited" };
    const sessions = [
      makeCompletedSession({ profileId: "p1", score: 1000, elapsedSeconds: 100, finishedAt: "2026-05-09T12:01:40Z" }),
      makeCompletedSession({ profileId: "p1", score: 2000, elapsedSeconds: 80, finishedAt: "2026-05-09T13:01:20Z" }),
      makeCompletedSession({ profileId: "p2", score: 1500, elapsedSeconds: 90, finishedAt: "2026-05-09T12:01:30Z" })
    ];
    const rows = buildLeaderboard({ challenge, sessions });
    expect(rows).toHaveLength(3);
    expect(rows[0].score).toBe(2000); // sorted high to low
  });

  test("excludes pending/in-progress sessions", () => {
    const sessions = [
      makeCompletedSession({ profileId: "p1", score: 1000, elapsedSeconds: 100, finishedAt: "2026-05-09T12:01:40Z" }),
      { ...makeCompletedSession({ profileId: "p2", score: 9999, elapsedSeconds: 60, finishedAt: null }), status: "in-progress" }
    ];
    const rows = buildLeaderboard({ challenge: baseChallenge, sessions });
    expect(rows).toHaveLength(1);
    expect(rows[0].profileId).toBe("p1");
  });

  test("sorts by score desc, then elapsed asc, then finishedAt asc", () => {
    const sessions = [
      makeCompletedSession({ profileId: "p1", score: 2000, elapsedSeconds: 100, finishedAt: "2026-05-09T13:00:00Z" }),
      makeCompletedSession({ profileId: "p2", score: 2000, elapsedSeconds: 80, finishedAt: "2026-05-09T12:00:00Z" })
    ];
    const rows = buildLeaderboard({ challenge: baseChallenge, sessions });
    // Same score, p2 has lower elapsed → first.
    expect(rows[0].profileId).toBe("p2");
  });
});

describe("checkReplayAllowed", () => {
  test("unlimited and best always allow", () => {
    expect(checkReplayAllowed({
      challenge: { replayPolicy: "unlimited" },
      pastSessions: [{ profileId: "p1", status: "completed" }],
      profileId: "p1"
    })).toBeNull();
    expect(checkReplayAllowed({
      challenge: { replayPolicy: "best" },
      pastSessions: [{ profileId: "p1", status: "completed" }],
      profileId: "p1"
    })).toBeNull();
  });

  test("first-only blocks if profile already played", () => {
    expect(checkReplayAllowed({
      challenge: { replayPolicy: "first-only" },
      pastSessions: [{ profileId: "p1", status: "completed" }],
      profileId: "p1"
    })).toBe("REPLAY_NOT_ALLOWED");
  });

  test("first-only allows different profile", () => {
    expect(checkReplayAllowed({
      challenge: { replayPolicy: "first-only" },
      pastSessions: [{ profileId: "other", status: "completed" }],
      profileId: "p1"
    })).toBeNull();
  });
});
