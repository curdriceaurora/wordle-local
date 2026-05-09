"use strict";

// Pure, framework-free helpers for the timed challenge feature.
// Anything that touches I/O lives in the stores and routes; this
// module is just math and state-transition logic so it can be unit
// tested deterministically.

class ChallengeEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChallengeEngineError";
    this.code = code;
  }
}

// Compute the total score for a completed (or timed-out) session.
// Formula:
//   score = sum(perPuzzleScore for each solved puzzle)
//         + max(0, timeBudgetSeconds - elapsedSeconds) * speedBonusFactor
// Floored to integer so the persisted score field is never fractional
// (the schema requires integer >= 0). Unsolved puzzles contribute 0.
function computeScore({
  challenge,
  puzzles,
  elapsedSeconds
}) {
  if (!challenge || typeof challenge !== "object") {
    throw new ChallengeEngineError("INVALID_REQUEST", "challenge config is required.");
  }
  if (!Array.isArray(puzzles)) {
    throw new ChallengeEngineError("INVALID_REQUEST", "puzzles must be an array.");
  }
  const solved = puzzles.filter((p) => p && p.solved === true).length;
  const baseScore = solved * (challenge.perPuzzleScore || 0);
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const remaining = Math.max(0, (challenge.timeBudgetSeconds || 0) - elapsed);
  const bonus = remaining * (challenge.speedBonusFactor || 0);
  return Math.max(0, Math.floor(baseScore + bonus));
}

// Server-authoritative remaining-time computation. Clients use this
// number for their countdown display — never their own clock — so
// disagreement between client and server time can't change the
// outcome.
function computeRemainingSeconds({ session, challenge, now = new Date() }) {
  if (!session || !challenge) {
    throw new ChallengeEngineError("INVALID_REQUEST", "session and challenge are required.");
  }
  const startMs = Date.parse(session.startedAt);
  if (!Number.isFinite(startMs)) return 0;
  const elapsedMs = Math.max(0, now.getTime() - startMs);
  const budgetMs = challenge.timeBudgetSeconds * 1000;
  return Math.max(0, Math.ceil((budgetMs - elapsedMs) / 1000));
}

// Decide whether the session has already exceeded its time budget.
// `now > startedAt + timeBudget`.
function hasTimedOut({ session, challenge, now = new Date() }) {
  return computeRemainingSeconds({ session, challenge, now }) <= 0;
}

// Returns the puzzle at the given index, or null if out of range.
// Sessions reveal puzzles one at a time: the player only ever sees
// the WORD field of the active puzzle (the engine strips word from
// other puzzles when shipping the session to the client).
function findPuzzleByIndex(session, index) {
  if (!session || !Array.isArray(session.puzzles)) return null;
  return session.puzzles.find((p) => p.index === index) || null;
}

// Build the player-visible projection of a session: same shape the
// server persists, but with un-solved puzzles' WORD field stripped
// (so the client cannot enumerate the answer set ahead of time).
// Each puzzle ALSO carries a server-computed `feedbacks` array (one
// entry per historical guess) so the client can render correct/
// present/absent tiles without ever seeing the answer for active
// puzzles. `evaluateGuess` is required — passed in by the caller so
// this module stays free of dependencies on server.js helpers.
function projectSessionForPlayer({ session, challenge, evaluateGuess, now = new Date(), includeAnswersForCompleted = true }) {
  if (!session || !challenge) return null;
  if (typeof evaluateGuess !== "function") {
    throw new ChallengeEngineError(
      "INVALID_REQUEST",
      "projectSessionForPlayer requires an evaluateGuess(guess, answer) function."
    );
  }
  const remainingSeconds = computeRemainingSeconds({ session, challenge, now });
  const isTerminal = session.status === "completed"
    || session.status === "timed-out"
    || session.status === "abandoned";
  const puzzles = session.puzzles.map((p) => {
    const guesses = Array.isArray(p.guesses) ? p.guesses.slice() : [];
    const feedbacks = guesses.map((g) => evaluateGuess(g, p.word));
    const out = {
      index: p.index,
      length: typeof p.word === "string" ? p.word.length : null,
      guesses,
      feedbacks,
      solved: p.solved === true
    };
    // Reveal the word only if the player has solved it OR the puzzle
    // ran out of guesses OR the session is in a terminal state and
    // history is being shown. Otherwise the word is hidden — even
    // for puzzles in the same session that come AFTER the active one.
    const exhausted = (out.guesses.length || 0) >= challenge.maxGuesses;
    if ((out.solved || exhausted) || (isTerminal && includeAnswersForCompleted)) {
      out.word = p.word;
    }
    return out;
  });
  return {
    id: session.id,
    challengeId: session.challengeId,
    status: session.status,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt || null,
    score: typeof session.score === "number" ? session.score : null,
    elapsedSeconds: typeof session.elapsedSeconds === "number" ? session.elapsedSeconds : null,
    remainingSeconds: isTerminal ? 0 : remainingSeconds,
    totalPuzzles: challenge.puzzleCount,
    activePuzzleIndex: isTerminal ? null : findFirstUnfinishedIndex(puzzles, challenge),
    puzzles
  };
}

function findFirstUnfinishedIndex(projectedPuzzles, challenge) {
  if (!Array.isArray(projectedPuzzles)) return null;
  const max = challenge.maxGuesses;
  for (const p of projectedPuzzles) {
    const exhausted = (p.guesses?.length || 0) >= max;
    if (!p.solved && !exhausted) return p.index;
  }
  return null;
}

// Build the per-challenge leaderboard: one row per profile (best score
// when replayPolicy=best, first attempt when replayPolicy=first-only,
// all attempts when replayPolicy=unlimited).
function buildLeaderboard({ challenge, sessions }) {
  if (!challenge || !Array.isArray(sessions)) return [];
  const policy = challenge.replayPolicy || "best";
  const TERMINAL = new Set(["completed", "timed-out"]);
  const filtered = sessions.filter((s) => TERMINAL.has(s.status));
  if (policy === "unlimited") {
    return filtered
      .map((s) => projectLeaderboardRow(s))
      .sort(leaderboardSorter);
  }
  // For best & first-only, group by profile.
  const byProfile = new Map();
  for (const s of filtered) {
    const existing = byProfile.get(s.profileId);
    if (!existing) {
      byProfile.set(s.profileId, s);
      continue;
    }
    if (policy === "best") {
      if ((s.score || 0) > (existing.score || 0)) byProfile.set(s.profileId, s);
    } else if (policy === "first-only") {
      if (Date.parse(s.startedAt) < Date.parse(existing.startedAt)) {
        byProfile.set(s.profileId, s);
      }
    }
  }
  return Array.from(byProfile.values())
    .map((s) => projectLeaderboardRow(s))
    .sort(leaderboardSorter);
}

function projectLeaderboardRow(session) {
  const solvedCount = session.puzzles.filter((p) => p.solved === true).length;
  return {
    sessionId: session.id,
    profileId: session.profileId,
    profileName: session.profileName || null,
    score: session.score || 0,
    solvedCount,
    totalPuzzles: session.puzzles.length,
    elapsedSeconds: session.elapsedSeconds || 0,
    finishedAt: session.finishedAt || null,
    status: session.status
  };
}

// Higher score first, then fewer elapsedSeconds, then earlier finish
// for tie-stability.
function leaderboardSorter(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.elapsedSeconds !== b.elapsedSeconds) return a.elapsedSeconds - b.elapsedSeconds;
  if (a.finishedAt && b.finishedAt) return a.finishedAt.localeCompare(b.finishedAt);
  return 0;
}

// Validate that the player can start a new session given the
// challenge's replay policy and any past sessions for this profile.
// Returns null if allowed; otherwise an error code. The caller maps
// the code to an HTTP status.
function checkReplayAllowed({ challenge, pastSessions, profileId }) {
  if (!challenge) return "CHALLENGE_NOT_FOUND";
  const policy = challenge.replayPolicy || "best";
  if (policy === "unlimited" || policy === "best") return null;
  // first-only — block if this profile already has a terminal session.
  const TERMINAL = new Set(["completed", "timed-out", "abandoned"]);
  const existing = pastSessions.find(
    (s) => s.profileId === profileId && TERMINAL.has(s.status)
  );
  return existing ? "REPLAY_NOT_ALLOWED" : null;
}

module.exports = {
  ChallengeEngineError,
  computeScore,
  computeRemainingSeconds,
  hasTimedOut,
  findPuzzleByIndex,
  projectSessionForPlayer,
  buildLeaderboard,
  projectLeaderboardRow,
  leaderboardSorter,
  checkReplayAllowed
};
