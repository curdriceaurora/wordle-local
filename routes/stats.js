const express = require("express");
const { randomUUID } = require("node:crypto");

/**
 * Stats routes factory
 * Provides leaderboard and player profile endpoints
 * @param {Object} deps - Dependencies
 * @param {Object} deps.leaderboardStore - LeaderboardStore instance for persisting stats
 * @param {Function} deps.normalizeProfileNameInput - Validates and normalizes profile name
 * @param {Function} deps.parseDailyResultPayload - Parses and validates result submission
 * @param {Function} deps.parseLeaderboardRange - Validates leaderboard range query param
 * @param {Function} deps.getLocalDateString - Converts Date to YYYY-MM-DD string
 * @param {Function} deps.buildLeaderboardRows - Builds sorted leaderboard rows for range
 * @param {Function} deps.buildProfilePerformance - Calculates profile stats and streaks
 * @param {Function} deps.statsServiceError - Formats error response for stats endpoints
 * @param {Function} deps.mapRegistryErrorToStats - Maps LanguageRegistryError to StatsApiError
 * @param {Function} deps.mergeDailyResult - Merges new result with existing result and retention state
 * @param {Function} deps.describeRange - Gets human-readable range description
 * @param {Function} deps.StatsApiError - Error class for stats validation errors
 * @returns {express.Router} Express router
 */
function createStatsRouter(deps) {
  const {
    leaderboardStore,
    classesStore,
    normalizeProfileNameInput,
    parseDailyResultPayload,
    parseLeaderboardRange,
    getLocalDateString,
    buildLeaderboardRows,
    buildProfilePerformance,
    statsServiceError,
    mapRegistryErrorToStats,
    mergeDailyResult,
    describeRange,
    StatsApiError
  } = deps;

  const router = express.Router();

  router.post("/api/stats/profile", async (req, res) => {
    let profileName;
    try {
      profileName = normalizeProfileNameInput(req.body?.name);
    } catch (err) {
      return statsServiceError(res, err);
    }

    try {
      let createdProfileId = "";
      let reused = false;

      // Capture pre-mutate IDs so we can detect cap-driven pruning. The
      // leaderboard normalizer can drop the oldest profile to keep the
      // host under maxProfiles when a brand-new profile is created.
      // Without reconciliation, a class roster that referenced the
      // pruned profile would silently develop a dangling reference.
      let preMutateIds = null;
      try {
        const preSnapshot = await leaderboardStore.getSnapshot();
        preMutateIds = new Set(preSnapshot.profiles.map((profile) => profile.id));
      } catch (_err) {
        // best effort — if the snapshot fails we skip reconciliation; the
        // mutate below will still persist or surface its own error.
      }

      const snapshot = await leaderboardStore.mutate((draft) => {
        const existing = draft.profiles.find(
          (profile) => profile.name.toLowerCase() === profileName.toLowerCase()
        );
        if (existing) {
          createdProfileId = existing.id;
          reused = true;
          return;
        }

        const nowIso = new Date().toISOString();
        const createdProfile = {
          id: randomUUID(),
          name: profileName,
          createdAt: nowIso,
          updatedAt: nowIso
        };
        draft.profiles.push(createdProfile);
        createdProfileId = createdProfile.id;
      });

      if (classesStore && preMutateIds && !reused) {
        const postIds = new Set(snapshot.profiles.map((profile) => profile.id));
        let prunedAny = false;
        for (const id of preMutateIds) {
          if (!postIds.has(id)) {
            prunedAny = true;
            break;
          }
        }
        if (prunedAny) {
          try {
            await classesStore.reconcileMissingProfiles(postIds);
          } catch (reconcileErr) {
            console.warn(
              `[stats] Profile creation pruned older profile(s) but class reconciliation failed: ${reconcileErr?.message || String(reconcileErr)}`
            );
          }
        }
      }

      const responseProfile = snapshot.profiles.find((profile) => profile.id === createdProfileId);
      if (!responseProfile) {
        throw new Error("Failed to persist player profile.");
      }

      return res.json({
        ok: true,
        reused,
        playerId: responseProfile.id,
        profile: responseProfile
      });
    } catch (err) {
      return statsServiceError(res, mapRegistryErrorToStats(err));
    }
  });

  router.post("/api/stats/result", async (req, res) => {
    let payload;
    try {
      payload = parseDailyResultPayload(req.body || {});
    } catch (err) {
      return statsServiceError(res, err);
    }

    try {
      let retained = false;
      const snapshot = await leaderboardStore.mutate((draft) => {
        const profile = draft.profiles.find((item) => item.id === payload.profileId);
        if (!profile) {
          throw new StatsApiError(404, "Player profile not found.");
        }

        const rawEntries = draft.resultsByProfile[payload.profileId];
        const currentEntries = new Map(
          Object.entries(rawEntries && typeof rawEntries === "object" ? rawEntries : {})
        );
        const nowIso = new Date().toISOString();
        const existing = currentEntries.get(payload.dailyKey) || null;
        const mergeOutcome = mergeDailyResult(existing, payload.entry, nowIso);
        retained = mergeOutcome.retained;
        currentEntries.set(payload.dailyKey, mergeOutcome.entry);
        draft.resultsByProfile[payload.profileId] = Object.fromEntries(currentEntries);
        profile.updatedAt = nowIso;
      });
      const persistedEntry = snapshot.resultsByProfile[payload.profileId]?.[payload.dailyKey] || null;
      const retainedInStore = retained && Boolean(persistedEntry);

      return res.json({
        ok: true,
        profileId: payload.profileId,
        dailyKey: payload.dailyKey,
        retained: retainedInStore,
        result: persistedEntry
      });
    } catch (err) {
      return statsServiceError(res, mapRegistryErrorToStats(err));
    }
  });

  router.get("/api/stats/leaderboard", async (req, res) => {
    let range;
    try {
      range = parseLeaderboardRange(req.query.range);
    } catch (err) {
      return statsServiceError(res, err);
    }

    try {
      const snapshot = await leaderboardStore.getSnapshot();
      const today = getLocalDateString(new Date());
      const rows = buildLeaderboardRows(snapshot, range, today);
      return res.json({
        ok: true,
        range,
        description: describeRange(range),
        dayKey: today,
        rowCount: rows.length,
        rows
      });
    } catch (err) {
      return statsServiceError(res, mapRegistryErrorToStats(err));
    }
  });

  router.get("/api/stats/profile/:id", async (req, res) => {
    const profileId = String(req.params.id || "").trim();
    if (!profileId) {
      return res.status(400).json({ error: "Profile ID is required." });
    }

    try {
      const snapshot = await leaderboardStore.getSnapshot();
      const profile = snapshot.profiles.find((item) => item.id === profileId);
      if (!profile) {
        return res.status(404).json({ error: "Player profile not found." });
      }

      const today = getLocalDateString(new Date());
      const performance = buildProfilePerformance(snapshot.resultsByProfile[profileId], today);
      const totalSubmissions = Object.values(snapshot.resultsByProfile[profileId] || {}).reduce(
        (sum, entry) => sum + Number(entry?.submissionCount || 0),
        0
      );

      return res.json({
        ok: true,
        profile,
        summary: {
          streak: performance.streak,
          overall: performance.overall,
          weekly: performance.weekly,
          monthly: performance.monthly,
          totalSubmissions
        }
      });
    } catch (err) {
      return statsServiceError(res, mapRegistryErrorToStats(err));
    }
  });

  return router;
}

module.exports = createStatsRouter;
