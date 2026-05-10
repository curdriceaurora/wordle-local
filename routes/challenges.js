"use strict";

const express = require("express");
const challengeEngine = require("../lib/challenge-engine");
const { translateForRequest } = require("../lib/server-i18n");

/**
 * Player-facing timed-challenge endpoints.
 *
 * Routes:
 *  GET    /api/challenges
 *  POST   /api/challenges/:id/start
 *  GET    /api/challenges/:id/sessions/:sessionId
 *  POST   /api/challenges/:id/sessions/:sessionId/guess
 *  POST   /api/challenges/:id/sessions/:sessionId/finish
 */
function createChallengesRouter(deps) {
  const {
    challengeConfigStore,
    challengeResultsStore,
    ChallengeConfigStoreError,
    ChallengeResultsStoreError,
    getDictionary,
    getAnswerDictionary,
    dictionaryHasWord,
    dictionaryRandomWord,
    evaluateGuess,
    isLanguageAvailable,
    challengeModeEnabled
  } = deps;

  if (!challengeConfigStore || !challengeResultsStore) {
    throw new TypeError("createChallengesRouter: challenge stores are required.");
  }
  if (typeof getAnswerDictionary !== "function"
    || typeof getDictionary !== "function"
    || typeof evaluateGuess !== "function") {
    throw new TypeError("createChallengesRouter: dictionary helpers are required.");
  }

  // Helper: build the full session projection that the client
  // consumes — including server-computed per-letter feedback for every
  // historical guess. Centralized so every endpoint that returns a
  // session uses the same shape.
  function projectForResponse(session, challenge, now = new Date()) {
    return challengeEngine.projectSessionForPlayer({
      session, challenge, evaluateGuess, now
    });
  }

  const router = express.Router();

  function challengeError(res, err, context) {
    if (err instanceof ChallengeConfigStoreError || err instanceof ChallengeResultsStoreError) {
      const status = err.code === "INVALID_REQUEST" ? 400
        : err.code === "CHALLENGE_NOT_FOUND" || err.code === "SESSION_NOT_FOUND" ? 404
        : err.code === "CONFIG_LOCKED" || err.code === "DUPLICATE_ID"
          || err.code === "SESSION_COMPLETE" || err.code === "SESSION_NOT_ACTIVE" ? 409
        : 503;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    console.error(`[challenge] ${context} failed:`, err);
    return res.status(503).json({ error: "Challenge request failed.", code: "INTERNAL" });
  }

  function ensureEnabled(req, res) {
    if (!challengeModeEnabled) {
      res.status(404).json({
        error: translateForRequest(req, "serverError.challengeModeDisabled"),
        code: "CHALLENGE_MODE_DISABLED"
      });
      return false;
    }
    return true;
  }

  function buildPuzzlesForChallenge(challenge) {
    const dict = getAnswerDictionary(challenge.lang);
    if (!dict) {
      const err = new Error(`No answer dictionary available for lang ${challenge.lang}.`);
      err.code = "LANG_UNAVAILABLE";
      throw err;
    }
    const targetLength = Number.isInteger(challenge.wordLength) ? challenge.wordLength : 5;
    const out = [];
    for (let i = 0; i < challenge.puzzleCount; i++) {
      const word = dictionaryRandomWord(dict, targetLength);
      if (!word) {
        const err = new Error(`Answer dictionary for ${challenge.lang} has no words of length ${targetLength}.`);
        err.code = "LANG_UNAVAILABLE";
        throw err;
      }
      out.push({ index: i, word: String(word).toUpperCase(), guesses: [], solved: false });
    }
    return out;
  }

  // Resolve profileId (and optional name) from the player request. The
  // existing leaderboard system already keys results by profileId, so
  // we accept that same shape here.
  function resolveProfile(body) {
    const profileId = typeof body?.profileId === "string" ? body.profileId.trim() : "";
    const profileName = typeof body?.profileName === "string" ? body.profileName.trim() : "";
    if (!profileId || profileId.length > 64) return null;
    return { profileId, profileName: profileName.length >= 1 && profileName.length <= 64 ? profileName : undefined };
  }

  // Server-authoritative timeout settle: if the session has run out of
  // time, mark it `timed-out`, compute the final score, and return the
  // updated session. Idempotent — the second call sees a terminal
  // status and returns it unchanged.
  async function settleIfTimedOut(session, challenge, now = new Date()) {
    if (session.status !== "in-progress" && session.status !== "pending") return session;
    if (!challengeEngine.hasTimedOut({ session, challenge, now })) return session;
    const elapsedSeconds = Math.max(
      0,
      Math.floor((now.getTime() - Date.parse(session.startedAt)) / 1000)
    );
    const cappedElapsed = Math.min(elapsedSeconds, challenge.timeBudgetSeconds);
    const score = challengeEngine.computeScore({
      challenge,
      puzzles: session.puzzles,
      elapsedSeconds: cappedElapsed
    });
    return challengeResultsStore.update(session.id, {
      status: "timed-out",
      finishedAt: now.toISOString(),
      elapsedSeconds: cappedElapsed,
      score
    });
  }

  router.get("/api/challenges", async (req, res) => {
    if (!ensureEnabled(req, res)) return;
    try {
      const all = await challengeConfigStore.listActive();
      const visible = all.map((c) => ({
        id: c.id,
        name: c.name,
        lang: c.lang,
        puzzleCount: c.puzzleCount,
        timeBudgetSeconds: c.timeBudgetSeconds,
        maxGuesses: c.maxGuesses,
        wordLength: c.wordLength || null,
        replayPolicy: c.replayPolicy,
        startTime: c.startTime || null,
        endTime: c.endTime || null
      }));
      return res.json({ ok: true, challenges: visible });
    } catch (err) {
      return challengeError(res, err, "list");
    }
  });

  router.post("/api/challenges/:id/start", async (req, res) => {
    if (!ensureEnabled(req, res)) return;
    const profile = resolveProfile(req.body);
    if (!profile) {
      return res.status(400).json({ error: "profileId is required.", code: "INVALID_REQUEST" });
    }
    try {
      const challenge = await challengeConfigStore.findById(req.params.id);
      if (!challenge || challenge.deleted) {
        return res.status(404).json({ error: translateForRequest(req, "serverError.challengeNotFound"), code: "CHALLENGE_NOT_FOUND" });
      }
      // Window check.
      const now = new Date();
      if (challenge.startTime && Date.parse(challenge.startTime) > now.getTime()) {
        return res.status(409).json({ error: "Challenge has not started yet.", code: "CHALLENGE_NOT_OPEN" });
      }
      if (challenge.endTime && Date.parse(challenge.endTime) <= now.getTime()) {
        return res.status(409).json({ error: "Challenge has ended.", code: "CHALLENGE_CLOSED" });
      }
      if (!isLanguageAvailable(challenge.lang)) {
        return res.status(503).json({
          error: `Language ${challenge.lang} is not currently available.`,
          code: "LANG_UNAVAILABLE"
        });
      }
      // Resume an in-flight session if one exists for this (challenge,
      // profile). Settle on timeout first so the resume path doesn't
      // hand back a stale "in-progress" snapshot for a session whose
      // budget already expired.
      let session = await challengeResultsStore.findInFlight(challenge.id, profile.profileId);
      if (session) {
        session = await settleIfTimedOut(session, challenge, now);
        if (session.status === "in-progress" || session.status === "pending") {
          const projected = projectForResponse(session, challenge, now);
          return res.status(200).json({ ok: true, session: projected, resumed: true });
        }
        // Otherwise fall through and create a new session per replay policy.
      }
      // Replay-policy gate.
      const past = (await challengeResultsStore.findCompletedForChallenge(challenge.id))
        .filter((s) => s.profileId === profile.profileId);
      const replayCheck = challengeEngine.checkReplayAllowed({
        challenge, pastSessions: past, profileId: profile.profileId
      });
      if (replayCheck) {
        return res.status(409).json({
          error: "Replay not allowed for this challenge under its replay policy.",
          code: replayCheck
        });
      }
      // Build server-side puzzles and persist.
      let puzzles;
      try {
        puzzles = buildPuzzlesForChallenge(challenge);
      } catch (err) {
        if (err.code === "LANG_UNAVAILABLE") {
          return res.status(503).json({ error: err.message, code: "LANG_UNAVAILABLE" });
        }
        throw err;
      }
      // createSession returns `{ session, resumed }` because it
      // re-checks the in-flight invariant atomically inside its
      // commit. A racing concurrent /start for the same (challengeId,
      // profileId) gets the existing in-flight session back as a
      // resume rather than creating a duplicate — matches what
      // findInFlight above would have caught if the timing had been
      // serial.
      const { session: created, resumed: createdResumed } = await challengeResultsStore.createSession({
        challengeId: challenge.id,
        profileId: profile.profileId,
        profileName: profile.profileName,
        startedAt: now.toISOString(),
        puzzles
      });
      const projected = projectForResponse(created, challenge, now);
      return res.status(createdResumed ? 200 : 201).json({
        ok: true,
        session: projected,
        resumed: createdResumed
      });
    } catch (err) {
      return challengeError(res, err, "start");
    }
  });

  async function loadSessionAndChallenge(req, res) {
    const challenge = await challengeConfigStore.findById(req.params.id);
    if (!challenge) {
      res.status(404).json({ error: translateForRequest(req, "serverError.challengeNotFound"), code: "CHALLENGE_NOT_FOUND" });
      return null;
    }
    const session = await challengeResultsStore.findById(req.params.sessionId);
    if (!session || session.challengeId !== challenge.id) {
      res.status(404).json({ error: translateForRequest(req, "serverError.sessionNotFound"), code: "SESSION_NOT_FOUND" });
      return null;
    }
    return { challenge, session };
  }

  router.get("/api/challenges/:id/sessions/:sessionId", async (req, res) => {
    if (!ensureEnabled(req, res)) return;
    try {
      const ctx = await loadSessionAndChallenge(req, res);
      if (!ctx) return;
      const settled = await settleIfTimedOut(ctx.session, ctx.challenge);
      const projected = projectForResponse(settled, ctx.challenge);
      return res.json({ ok: true, session: projected });
    } catch (err) {
      return challengeError(res, err, "get session");
    }
  });

  router.post("/api/challenges/:id/sessions/:sessionId/guess", async (req, res) => {
    if (!ensureEnabled(req, res)) return;
    try {
      const ctx = await loadSessionAndChallenge(req, res);
      if (!ctx) return;
      let { challenge, session } = ctx;
      session = await settleIfTimedOut(session, challenge);
      if (session.status !== "in-progress" && session.status !== "pending") {
        return res.status(409).json({
          error: `Session is ${session.status}; no further guesses accepted.`,
          code: "SESSION_NOT_ACTIVE"
        });
      }
      const rawGuess = String(req.body?.guess || "").trim().toUpperCase();
      if (!/^[A-Z]+$/.test(rawGuess)) {
        return res.status(400).json({ error: "guess must be A–Z only.", code: "INVALID_REQUEST" });
      }
      // Use the FULL guess dictionary here — answer dictionary is the
      // narrower pool used to PICK target words, but valid guesses
      // are anything in the language's full vocabulary, matching how
      // /api/guess works for daily/created puzzles. Provider-imported
      // languages with curated answer pools were rejecting valid
      // guesses before this fix.
      const guessDict = getDictionary(challenge.lang);
      // Length-aware: each puzzle has a length determined at start;
      // mismatched-length guesses are rejected without consuming a try.
      // Find the active puzzle (first not-solved-not-exhausted).
      const active = session.puzzles.find(
        (p) => !p.solved && (p.guesses?.length || 0) < challenge.maxGuesses
      );
      if (!active) {
        // Active puzzle is null → all puzzles done. Status should be
        // updated in the next finish call but we don't auto-complete
        // here so finish remains the explicit transition point.
        return res.status(409).json({
          error: "All puzzles in this session are complete.",
          code: "SESSION_COMPLETE"
        });
      }
      if (rawGuess.length !== active.word.length) {
        return res.status(400).json({
          error: `guess must be ${active.word.length} letters.`,
          code: "INVALID_REQUEST"
        });
      }
      // Allow non-dictionary guesses if the dict is unavailable; reject
      // bogus guesses if the dict is loaded. Mirror /api/word's stance.
      if (guessDict && !dictionaryHasWord(guessDict, rawGuess)) {
        return res.status(400).json({
          error: "Not in word list.",
          code: "INVALID_GUESS"
        });
      }
      // Mutate atomically inside the store's commit lock. The earlier
      // version computed updatedPuzzles outside the commit and then
      // sent the whole array as a patch — two concurrent /guess
      // requests would both compute from the same stale snapshot and
      // the second commit's puzzles array would overwrite the first
      // guess. Reading the latest session inside the mutator (via
      // transactionalUpdate) closes that race.
      //
      // Compute feedback INSIDE the mutator too. The pre-transaction
      // `active` puzzle and its `active.word` could be stale by the
      // time the lock is acquired (a concurrent /guess for the same
      // session may have solved or exhausted it), and `latestActive`
      // can refer to a different puzzle entirely. Returning feedback
      // computed from `active.word` would then color the wrong row in
      // the client. Capture both feedback and the post-mutation status
      // via outer-scope locals so the response reflects what was
      // actually applied.
      let appliedFeedback = null;
      const updated = await challengeResultsStore.transactionalUpdate(session.id, (latest) => {
        // Latest-status TOCTOU: a concurrent /finish or settle-on-
        // timeout could have transitioned this session to terminal
        // since the route's pre-transaction read. Re-check inside the
        // commit so we never apply a guess to a completed/timed-out/
        // abandoned session.
        if (latest.status !== "in-progress" && latest.status !== "pending") {
          throw new ChallengeResultsStoreError(
            "SESSION_NOT_ACTIVE",
            `Session is ${latest.status}; no further guesses accepted.`
          );
        }
        // Re-derive the active puzzle from the LATEST persisted state.
        // This handles the case where another /guess has already
        // landed: we'll see its updated puzzle, find the new active
        // puzzle (or none), and append our guess to that one. The
        // length check above used `active.word.length`, which is
        // immutable for a given puzzle index, so the request body's
        // length validation still holds for the latest active puzzle.
        const latestActive = latest.puzzles.find(
          (p) => !p.solved && (p.guesses?.length || 0) < challenge.maxGuesses
        );
        if (!latestActive) {
          throw new ChallengeResultsStoreError(
            "SESSION_COMPLETE",
            "All puzzles in this session are complete."
          );
        }
        // Feedback is now derived from the puzzle that actually
        // receives the guess. With concurrent /guess invocations,
        // latestActive can be a different puzzle than the
        // pre-transaction `active`; computing here ensures the
        // returned colors match the persisted update.
        appliedFeedback = evaluateGuess(rawGuess, latestActive.word);
        const updatedPuzzles = latest.puzzles.map((p) => {
          if (p.index !== latestActive.index) return p;
          const guesses = (p.guesses || []).concat(rawGuess);
          const solved = rawGuess === p.word;
          return { ...p, guesses, solved };
        });
        const merged = { ...latest, puzzles: updatedPuzzles };
        const allDone = updatedPuzzles.every(
          (p) => p.solved || (p.guesses?.length || 0) >= challenge.maxGuesses
        );
        if (allDone) {
          const now = new Date();
          let elapsedFinal = Math.max(
            0,
            Math.floor((now.getTime() - Date.parse(latest.startedAt)) / 1000)
          );
          elapsedFinal = Math.min(elapsedFinal, challenge.timeBudgetSeconds);
          merged.finishedAt = now.toISOString();
          merged.elapsedSeconds = elapsedFinal;
          merged.score = challengeEngine.computeScore({
            challenge,
            puzzles: updatedPuzzles,
            elapsedSeconds: elapsedFinal
          });
          merged.status = "completed";
        } else {
          merged.status = latest.status;
        }
        return merged;
      });
      const projected = projectForResponse(updated, challenge);
      // Submit score to the leaderboard projection on completion.
      // Surface the per-guess feedback row that the client renders.
      return res.json({
        ok: true,
        session: projected,
        feedback: appliedFeedback
      });
    } catch (err) {
      return challengeError(res, err, "guess");
    }
  });

  router.get("/api/challenges/:id/leaderboard", async (req, res) => {
    if (!ensureEnabled(req, res)) return;
    try {
      const challenge = await challengeConfigStore.findById(req.params.id);
      if (!challenge || challenge.deleted) {
        return res.status(404).json({ error: translateForRequest(req, "serverError.challengeNotFound"), code: "CHALLENGE_NOT_FOUND" });
      }
      const sessions = await challengeResultsStore.findCompletedForChallenge(challenge.id);
      const rows = challengeEngine.buildLeaderboard({ challenge, sessions });
      // Slim challenge metadata only — never echo soft-delete reason or
      // operator-internal fields that aren't already in the player's
      // /api/challenges projection.
      return res.json({
        ok: true,
        challenge: {
          id: challenge.id,
          name: challenge.name,
          replayPolicy: challenge.replayPolicy,
          puzzleCount: challenge.puzzleCount,
          timeBudgetSeconds: challenge.timeBudgetSeconds
        },
        rows
      });
    } catch (err) {
      return challengeError(res, err, "leaderboard");
    }
  });

  router.post("/api/challenges/:id/sessions/:sessionId/finish", async (req, res) => {
    if (!ensureEnabled(req, res)) return;
    try {
      const ctx = await loadSessionAndChallenge(req, res);
      if (!ctx) return;
      let { challenge, session } = ctx;
      session = await settleIfTimedOut(session, challenge);
      if (session.status !== "in-progress" && session.status !== "pending") {
        // Idempotent: finishing a terminal session returns the same
        // settled state.
        const projected = projectForResponse(session, challenge);
        return res.json({ ok: true, session: projected, alreadyFinal: true });
      }
      // Player can finish early — abandoning unfinished puzzles. Score
      // counts only solved puzzles.
      const now = new Date();
      const elapsed = Math.min(
        challenge.timeBudgetSeconds,
        Math.max(0, Math.floor((now.getTime() - Date.parse(session.startedAt)) / 1000))
      );
      const allDone = session.puzzles.every(
        (p) => p.solved || (p.guesses?.length || 0) >= challenge.maxGuesses
      );
      const score = challengeEngine.computeScore({
        challenge, puzzles: session.puzzles, elapsedSeconds: elapsed
      });
      const finalStatus = allDone ? "completed" : "abandoned";
      const updated = await challengeResultsStore.update(session.id, {
        status: finalStatus,
        finishedAt: now.toISOString(),
        elapsedSeconds: elapsed,
        score
      });
      const projected = projectForResponse(updated, challenge, now);
      return res.json({ ok: true, session: projected, alreadyFinal: false });
    } catch (err) {
      return challengeError(res, err, "finish");
    }
  });

  return router;
}

module.exports = createChallengesRouter;
