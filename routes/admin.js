const express = require("express");
const { randomUUID } = require("node:crypto");

/**
 * Admin routes factory
 * Provides admin UI, provider management, runtime config, job queue, and admin stats endpoints
 * @param {Object} deps - Dependencies
 * @param {Object} deps.ADMIN_SHELL - Admin shell asset paths
 * @param {Function} deps.buildProviderStatusRows - Builds provider status summary
 * @param {Function} deps.parseProviderVariant - Validates and normalizes provider variant
 * @param {Function} deps.parseProviderImportSource - Validates import source type
 * @param {Function} deps.parseProviderFilterMode - Validates filter mode
 * @param {Function} deps.providerAdminError - Formats error response for provider admin endpoints
 * @param {Function} deps.statsServiceError - Formats error response for stats endpoints
 * @param {Function} deps.mapRegistryErrorToStats - Maps LanguageRegistryError to StatsApiError
 * @param {Function} deps.mapProviderPipelineError - Maps provider pipeline errors to StatsApiError
 * @param {Function} deps.mapProviderUpdateCheckErrorToMessage - Maps update check errors to messages
 * @param {Function} deps.resolveCurrentProviderCommitForUpdateCheck - Resolves current commit for update check
 * @param {Function} deps.resolvePreferredProviderCommit - Resolves preferred commit for variant
 * @param {Function} deps.normalizeProfileNameInput - Validates and normalizes profile name
 * @param {Function} deps.fetchAndPersistProviderSource - Fetches and saves provider source files
 * @param {Function} deps.persistManualProviderSource - Persists manually uploaded provider files
 * @param {Function} deps.buildExpandedFormsArtifacts - Builds expanded forms from hunspell
 * @param {Function} deps.buildProviderPoolsArtifacts - Builds guess and answer pools
 * @param {Function} deps.buildFilteredAnswerPoolArtifacts - Builds filtered answer pool
 * @param {Function} deps.checkProviderUpdate - Checks upstream for provider updates
 * @param {Function} deps.buildProviderArtifactPaths - Builds artifact file paths for variant/commit
 * @param {Function} deps.getProviderVariantLabel - Gets human-readable variant label
 * @param {Function} deps.loadDictionary - Loads dictionary file into memory
 * @param {Function} deps.rebuildLanguageRuntimeCatalog - Rebuilds language catalog from registry
 * @param {Object} deps.leaderboardStore - LeaderboardStore instance for persisting stats
 * @param {Object} deps.languageRegistryStore - LanguageRegistryStore instance
 * @param {Object} deps.adminJobsStore - AdminJobsStore instance for job queue
 * @param {Object} deps.appConfigStore - AppConfigStore instance for runtime config
 * @param {Object} deps.providerImportQueueActiveRef - Mutable reference to async queue active flag
 * @param {Function} deps.buildRuntimeConfigResponse - Builds runtime config response
 * @param {Function} deps.applyRuntimeConfig - Applies runtime config overrides
 * @param {Function} deps.buildImportQueueSummary - Builds import queue summary
 * @param {Function} deps.toAdminJobResponse - Maps job to response shape
 * @param {Function} deps.parseImportAsyncFlag - Parses async flag from request
 * @param {Function} deps.parsePositiveInteger - Parses positive integer with fallback
 * @param {Function} deps.normalizeExpectedChecksums - Normalizes checksum input
 * @param {Function} deps.runProviderImportPipeline - Runs provider import pipeline synchronously
 * @param {Function} deps.startProviderImportQueueIfNeeded - Starts queue processing
 * @param {Function} deps.formatProviderJobError - Formats job error for storage
 * @param {Function} deps.persistManualUploadStaging - Persists manual upload files for async jobs
 * @param {Function} deps.cleanupManualUploadStaging - Cleans up staged manual upload files
 * @param {Function} deps.getProviderManualMaxFileBytes - Returns max bytes for manual uploads
 * @param {Object} deps.PROVIDER_COMMIT_PATTERN - Regex pattern for git commit SHA
 * @param {Object} deps.PROVIDER_IMPORT_SOURCE_TYPES - Enum of import source types
 * @param {Number} deps.PROVIDER_MANUAL_MAX_FILE_BYTES - Max bytes for manual uploads
 * @param {Number} deps.PROVIDER_MIN_LENGTH - Minimum word length for provider
 * @param {String} deps.PROVIDER_POLICY_VERSION - Provider policy version string
 * @param {String} deps.PROVIDER_ID - Provider identifier
 * @param {String} deps.PROVIDER_REPOSITORY - Provider upstream repository URL
 * @param {String} deps.PROVIDERS_ROOT - Root directory for provider artifacts
 * @param {Function} deps.StatsApiError - Error class for stats validation errors
 * @param {Function} deps.ProviderUpdateCheckError - Error class for update check failures
 * @param {Function} deps.AppConfigStoreError - Error class for app config store errors
 * @returns {express.Router} Express router
 */
function createAdminRouter(deps) {
  const {
    ADMIN_SHELL,
    buildProviderStatusRows,
    parseProviderVariant,
    parseProviderImportSource,
    parseProviderFilterMode,
    providerAdminError,
    statsServiceError,
    mapRegistryErrorToStats,
    mapProviderPipelineError,
    mapProviderUpdateCheckErrorToMessage,
    resolveCurrentProviderCommitForUpdateCheck,
    resolvePreferredProviderCommit,
    normalizeProfileNameInput,
    checkProviderUpdate,
    buildProviderArtifactPaths,
    getProviderVariantLabel,
    loadDictionary,
    rebuildLanguageRuntimeCatalog,
    leaderboardStore,
    languageRegistryStore,
    adminJobsStore,
    appConfigStore,
    providerImportQueueActiveRef,
    providerImportSyncActiveRef,
    buildRuntimeConfigResponse,
    applyRuntimeConfig,
    buildImportQueueSummary,
    toAdminJobResponse,
    parseImportAsyncFlag,
    parsePositiveInteger,
    normalizeExpectedChecksums,
    runProviderImportPipeline,
    startProviderImportQueueIfNeeded,
    formatProviderJobError,
    persistManualUploadStaging,
    cleanupManualUploadStaging,
    getProviderManualMaxFileBytes,
    getEditableProviderManualMaxFileBytes,
    PROVIDER_MANUAL_MAX_FILE_BYTES_MIN,
    PROVIDER_COMMIT_PATTERN,
    PROVIDER_IMPORT_SOURCE_TYPES,
    PROVIDER_MIN_LENGTH,
    PROVIDER_ID,
    PROVIDER_REPOSITORY,
    LEADERBOARD_MAX_PROFILES_MIN,
    LEADERBOARD_MAX_PROFILES_MAX,
    LEADERBOARD_MAX_RESULTS_PER_PROFILE_MIN,
    LEADERBOARD_MAX_RESULTS_PER_PROFILE_MAX,
    isLeaderboardMaxProfilesEnvLocked,
    LeaderboardStoreError,
    StatsApiError,
    ProviderUpdateCheckError,
    AppConfigStoreError
  } = deps;

  const router = express.Router();

  router.get("/admin", (req, res) => {
    // Keep admin entry HTML uncached so key-gated shell changes apply immediately.
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(ADMIN_SHELL.indexPath);
  });

  router.patch("/api/admin/stats/profile/:id", async (req, res) => {
    const profileId = String(req.params.id || "").trim();
    if (!profileId) {
      return res.status(400).json({ error: "Profile ID is required." });
    }

    let nextName;
    try {
      nextName = normalizeProfileNameInput(req.body?.name);
    } catch (err) {
      return statsServiceError(res, err);
    }

    try {
      const snapshot = await leaderboardStore.mutate((draft) => {
        const profile = draft.profiles.find((item) => item.id === profileId);
        if (!profile) {
          throw new StatsApiError(404, "Player profile not found.");
        }
        const duplicate = draft.profiles.find(
          (item) => item.id !== profileId && item.name.toLowerCase() === nextName.toLowerCase()
        );
        if (duplicate) {
          throw new StatsApiError(409, "Another player already uses that name.");
        }
        const nowIso = new Date().toISOString();
        profile.name = nextName;
        profile.updatedAt = nowIso;
      });
      const persistedProfile = snapshot.profiles.find((item) => item.id === profileId) || null;
      if (!persistedProfile) {
        throw new Error("Failed to persist player profile rename.");
      }

      return res.json({ ok: true, profile: persistedProfile });
    } catch (err) {
      return statsServiceError(res, mapRegistryErrorToStats(err));
    }
  });

  router.get("/api/admin/stats/profiles", async (req, res) => {
    try {
      const snapshot = await leaderboardStore.getSnapshot();
      const profiles = snapshot.profiles.map((profile) => {
        const results = snapshot.resultsByProfile?.[profile.id] || {};
        let totalGames = 0;
        let wins = 0;
        let winningAttemptsSum = 0;
        let winningAttemptsCount = 0;
        let lastPlayedAt = null;

        for (const entry of Object.values(results)) {
          totalGames += 1;
          if (entry.won === true) {
            wins += 1;
            if (Number.isInteger(entry.attempts)) {
              winningAttemptsSum += entry.attempts;
              winningAttemptsCount += 1;
            }
          }
          if (entry.updatedAt && (!lastPlayedAt || entry.updatedAt > lastPlayedAt)) {
            lastPlayedAt = entry.updatedAt;
          }
        }

        return {
          id: profile.id,
          name: profile.name,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
          stats: {
            totalGames,
            wins,
            losses: totalGames - wins,
            winRate: totalGames > 0 ? wins / totalGames : 0,
            // averageWinningAttempts is the meaningful metric — losses store
            // attempts=null per schema, so any "average across all games"
            // would either drop those rows or pretend a loss was 0 attempts.
            averageWinningAttempts:
              winningAttemptsCount > 0 ? winningAttemptsSum / winningAttemptsCount : 0,
            lastPlayedAt
          }
        };
      });
      return res.json({ ok: true, profiles });
    } catch (err) {
      console.error("Admin profile list failed.", err);
      return res.status(503).json({ error: "Profile list unavailable right now. Try again soon." });
    }
  });

  router.delete("/api/admin/stats/profile/:id", async (req, res) => {
    const profileId = String(req.params.id || "").trim();
    if (!profileId) {
      return res.status(400).json({ error: "Profile ID is required." });
    }

    if (req.body?.confirmed !== true) {
      return res.status(400).json({
        error: "confirmed=true is required to delete a profile."
      });
    }

    const confirmName = typeof req.body?.confirmName === "string"
      ? req.body.confirmName.trim()
      : "";
    if (!confirmName) {
      return res.status(400).json({
        error: "confirmName is required and must match the profile name exactly."
      });
    }

    try {
      await leaderboardStore.deleteProfile(profileId, { expectedName: confirmName });
      return res.json({ ok: true, deletedProfileId: profileId });
    } catch (err) {
      if (err instanceof LeaderboardStoreError) {
        if (err.code === "PROFILE_NOT_FOUND") {
          return res.status(404).json({ error: err.message });
        }
        if (err.code === "PROFILE_NAME_MISMATCH") {
          return res.status(409).json({ error: err.message });
        }
        return res.status(400).json({ error: err.message });
      }
      console.error("Admin profile delete failed.", err);
      return res.status(503).json({ error: "Profile delete unavailable right now. Try again soon." });
    }
  });

  router.post("/api/admin/stats/profile/:id/merge", async (req, res) => {
    const sourceId = String(req.params.id || "").trim();
    const targetId = typeof req.body?.targetProfileId === "string"
      ? req.body.targetProfileId.trim()
      : "";

    if (!sourceId) {
      return res.status(400).json({ error: "Source profile ID is required." });
    }
    if (!targetId) {
      return res.status(400).json({ error: "targetProfileId is required." });
    }
    if (sourceId === targetId) {
      return res.status(400).json({ error: "Cannot merge a profile into itself." });
    }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({
        error: "confirmed=true is required to merge profiles."
      });
    }

    try {
      const snapshot = await leaderboardStore.mergeProfiles(sourceId, targetId);
      const mergedProfile = snapshot.profiles.find((profile) => profile.id === targetId) || null;
      if (!mergedProfile) {
        throw new Error("Failed to persist merged profile.");
      }
      return res.json({
        ok: true,
        mergedProfile,
        deletedProfileId: sourceId
      });
    } catch (err) {
      if (err instanceof LeaderboardStoreError) {
        if (err.code === "PROFILE_NOT_FOUND") {
          return res.status(404).json({ error: err.message });
        }
        return res.status(400).json({ error: err.message });
      }
      console.error("Admin profile merge failed.", err);
      return res.status(503).json({ error: "Profile merge unavailable right now. Try again soon." });
    }
  });

  router.get("/api/admin/runtime-config", (req, res) => {
    return res.json(buildRuntimeConfigResponse());
  });

  router.put("/api/admin/runtime-config", async (req, res) => {
    try {
      const requestedManualUploadMaxBytes = req.body?.overrides?.limits?.providerManualMaxFileBytes;
      if (requestedManualUploadMaxBytes !== undefined) {
        const parsedRequestedMaxBytes = Number(requestedManualUploadMaxBytes);
        const editableProviderManualMaxFileBytes = getEditableProviderManualMaxFileBytes();
        if (
          !Number.isInteger(parsedRequestedMaxBytes)
          || parsedRequestedMaxBytes > editableProviderManualMaxFileBytes
        ) {
          return res.status(400).json({
            error: `overrides.limits.providerManualMaxFileBytes must be an integer between ${PROVIDER_MANUAL_MAX_FILE_BYTES_MIN} and ${editableProviderManualMaxFileBytes}.`
          });
        }
      }

      const requestedMaxProfiles = req.body?.overrides?.limits?.leaderboardMaxProfiles;
      if (requestedMaxProfiles !== undefined) {
        const parsed = Number(requestedMaxProfiles);
        if (
          !Number.isInteger(parsed)
          || parsed < LEADERBOARD_MAX_PROFILES_MIN
          || parsed > LEADERBOARD_MAX_PROFILES_MAX
        ) {
          return res.status(400).json({
            error: `overrides.limits.leaderboardMaxProfiles must be an integer between ${LEADERBOARD_MAX_PROFILES_MIN} and ${LEADERBOARD_MAX_PROFILES_MAX}.`
          });
        }
        // Skip the count check when the env locks the cap — the persisted
        // override is dormant in that case, so it cannot orphan profiles.
        if (!isLeaderboardMaxProfilesEnvLocked()) {
          const snapshot = await leaderboardStore.getSnapshot();
          if (parsed < snapshot.profiles.length) {
            return res.status(409).json({
              error: `Cannot lower leaderboardMaxProfiles to ${parsed}; ${snapshot.profiles.length} profiles are currently registered.`
            });
          }
        }
      }

      const requestedMaxResults = req.body?.overrides?.limits?.leaderboardMaxResultsPerProfile;
      if (requestedMaxResults !== undefined) {
        const parsed = Number(requestedMaxResults);
        if (
          !Number.isInteger(parsed)
          || parsed < LEADERBOARD_MAX_RESULTS_PER_PROFILE_MIN
          || parsed > LEADERBOARD_MAX_RESULTS_PER_PROFILE_MAX
        ) {
          return res.status(400).json({
            error: `overrides.limits.leaderboardMaxResultsPerProfile must be an integer between ${LEADERBOARD_MAX_RESULTS_PER_PROFILE_MIN} and ${LEADERBOARD_MAX_RESULTS_PER_PROFILE_MAX}.`
          });
        }
      }

      // Snapshot the current overrides so a failed normalize can roll back
      // both disk and in-memory state, keeping GET /api/admin/runtime-config
      // honest about what the store is actually enforcing.
      const previousOverrides = appConfigStore.getOverridesSync();
      const nextState = appConfigStore.replaceOverridesSync(req.body?.overrides || {});
      try {
        await applyRuntimeConfig(nextState.overrides || {});
      } catch (applyErr) {
        try {
          appConfigStore.replaceOverridesSync(previousOverrides);
          applyRuntimeConfig(previousOverrides);
        } catch (rollbackErr) {
          console.error(
            "[runtime-config] Rollback after apply failure also failed.",
            rollbackErr
          );
        }
        throw applyErr;
      }
      return res.json(buildRuntimeConfigResponse());
    } catch (err) {
      if (err instanceof AppConfigStoreError && err.code === "INVALID_OVERRIDES") {
        return res.status(400).json({ error: err.message });
      }
      console.error("Runtime config update failed.", err);
      return res.status(503).json({ error: "Runtime config update failed right now. Try again soon." });
    }
  });

  router.get("/api/admin/jobs", async (req, res) => {
    let status = "";
    const rawStatus = String(req.query.status || "").trim();
    if (rawStatus) {
      if (!["queued", "running", "succeeded", "failed", "canceled"].includes(rawStatus)) {
        return res.status(400).json({ error: "status must be queued, running, succeeded, failed, or canceled." });
      }
      status = rawStatus;
    }

    const limit = parsePositiveInteger(Number(req.query.limit), 50);
    try {
      const [jobs, snapshot] = await Promise.all([
        adminJobsStore.list({ limit, status }),
        adminJobsStore.getSnapshot()
      ]);
      return res.json({
        ok: true,
        queue: buildImportQueueSummary(snapshot),
        jobs: jobs.map((job) => toAdminJobResponse(job))
      });
    } catch (err) {
      console.error("Admin jobs request failed.", err);
      return res.status(503).json({ error: "Import queue unavailable right now. Try again soon." });
    }
  });

  router.get("/api/admin/jobs/:id", async (req, res) => {
    const jobId = String(req.params.id || "").trim();
    if (!jobId) {
      return res.status(400).json({ error: "Job ID is required." });
    }

    try {
      const [job, snapshot] = await Promise.all([
        adminJobsStore.getById(jobId),
        adminJobsStore.getSnapshot()
      ]);
      if (!job) {
        return res.status(404).json({ error: "Import job not found." });
      }
      return res.json({
        ok: true,
        queue: buildImportQueueSummary(snapshot),
        job: toAdminJobResponse(job)
      });
    } catch (err) {
      console.error("Admin job lookup failed.", err);
      return res.status(503).json({ error: "Import queue unavailable right now. Try again soon." });
    }
  });

  router.get("/api/admin/providers", (req, res) => {
    return res.json({
      ok: true,
      providers: buildProviderStatusRows()
    });
  });

  router.post("/api/admin/providers/import", async (req, res) => {
    let sourceType;
    let variant;
    let filterMode;
    let importAsync;
    let expectedChecksums;
    let commitInput;

    try {
      sourceType = parseProviderImportSource(req.body?.sourceType);
      variant = parseProviderVariant(req.body?.variant);
      filterMode = parseProviderFilterMode(req.body?.filterMode);
      importAsync = parseImportAsyncFlag(req.body?.async);
      expectedChecksums = normalizeExpectedChecksums(req.body?.expectedChecksums);
      commitInput = String(req.body?.commit || "").trim();

      if (
        sourceType === PROVIDER_IMPORT_SOURCE_TYPES.REMOTE_FETCH
        && !PROVIDER_COMMIT_PATTERN.test(commitInput)
      ) {
        throw new StatsApiError(400, "commit must be a 40-character lowercase hexadecimal git SHA.");
      }
      if (
        sourceType === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD
        && commitInput
        && !PROVIDER_COMMIT_PATTERN.test(commitInput)
      ) {
        throw new StatsApiError(
          400,
          "commit must be a 40-character lowercase hexadecimal git SHA when provided."
        );
      }
    } catch (err) {
      return providerAdminError(res, err);
    }

    if (!importAsync) {
      if (providerImportQueueActiveRef.value || providerImportSyncActiveRef.value) {
        return providerAdminError(
          res,
          new StatsApiError(
            409,
            "Another queued import is currently running. Retry with async=true or wait for completion."
          )
        );
      }

      providerImportSyncActiveRef.value = true;
      try {
        const result = await runProviderImportPipeline({
          sourceType,
          variant,
          commit: commitInput || null,
          expectedChecksums,
          filterMode,
          manualFiles: req.body?.manualFiles
        });
        return res.json({
          ...result,
          providers: buildProviderStatusRows()
        });
      } catch (err) {
        return providerAdminError(res, mapProviderPipelineError(err));
      } finally {
        providerImportSyncActiveRef.value = false;
        startProviderImportQueueIfNeeded().catch((queueErr) => {
          console.error("Provider import queue processing failed.", queueErr);
        });
      }
    }

    // Async path: enqueue job
    let queuedJob = null;
    let stagedManualUpload = null;
    try {
      const requestPayload = {
        sourceType,
        variant,
        commit: sourceType === PROVIDER_IMPORT_SOURCE_TYPES.REMOTE_FETCH ? commitInput : commitInput || null,
        expectedChecksums,
        filterMode
      };

      if (sourceType === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD) {
        stagedManualUpload = await persistManualUploadStaging(
          `job-${randomUUID()}`,
          req.body?.manualFiles,
          getProviderManualMaxFileBytes()
        );
        requestPayload.manualUpload = stagedManualUpload;
      }

      queuedJob = await adminJobsStore.enqueueProviderImportJob(requestPayload, {
        requestedBy: "admin"
      });
    } catch (err) {
      if (queuedJob?.id) {
        await adminJobsStore.markFailed(queuedJob.id, formatProviderJobError(err)).catch(() => {});
      }
      await cleanupManualUploadStaging(stagedManualUpload).catch(() => {});
      return providerAdminError(res, err instanceof StatsApiError ? err : mapProviderPipelineError(err));
    }

    startProviderImportQueueIfNeeded().catch((err) => {
      console.error("Provider import queue processing failed.", err);
    });

    try {
      const refreshed = await adminJobsStore.getById(queuedJob.id);
      const snapshot = await adminJobsStore.getSnapshot();
      return res.status(202).json({
        ok: true,
        action: "queued",
        queue: buildImportQueueSummary(snapshot),
        job: toAdminJobResponse(refreshed || queuedJob),
        providers: buildProviderStatusRows()
      });
    } catch (err) {
      console.error("Failed to fetch queued import job state.", err);
      return res.status(202).json({
        ok: true,
        action: "queued",
        job: toAdminJobResponse(queuedJob),
        providers: buildProviderStatusRows()
      });
    }
  });

  router.post("/api/admin/providers/:variant/check-update", async (req, res) => {
    let variant;
    try {
      variant = parseProviderVariant(req.params.variant);
    } catch (err) {
      return providerAdminError(res, err);
    }

    let currentCommit;
    try {
      currentCommit = resolveCurrentProviderCommitForUpdateCheck(variant, req.body?.commit);
    } catch (err) {
      return providerAdminError(res, err);
    }

    try {
      const result = await checkProviderUpdate({
        variant,
        currentCommit,
        githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""
      });
      return res.json({
        ok: true,
        ...result,
        providers: buildProviderStatusRows()
      });
    } catch (err) {
      if (
        err instanceof ProviderUpdateCheckError &&
        (err.code === "UNSUPPORTED_VARIANT" || err.code === "INVALID_COMMIT")
      ) {
        return providerAdminError(res, new StatsApiError(400, err.message));
      }

      return res.json({
        ok: true,
        providerId: PROVIDER_ID,
        repository: PROVIDER_REPOSITORY,
        variant,
        checkedAt: new Date().toISOString(),
        status: "error",
        message: mapProviderUpdateCheckErrorToMessage(err),
        currentCommit,
        latestCommit: null,
        latestByPath: null,
        providers: buildProviderStatusRows()
      });
    }
  });

  router.post("/api/admin/providers/:variant/enable", (req, res) => {
    let variant;
    try {
      variant = parseProviderVariant(req.params.variant);
    } catch (err) {
      return providerAdminError(res, err);
    }

    let commit;
    try {
      commit = resolvePreferredProviderCommit(variant, req.body?.commit);
    } catch (err) {
      return providerAdminError(res, err);
    }

    try {
      const paths = buildProviderArtifactPaths(variant, commit);
      const minLength = PROVIDER_MIN_LENGTH;
      const guessDictionary = loadDictionary(paths.guessPool, minLength);
      const answerDictionary = loadDictionary(paths.answerPoolActive, minLength)
        || loadDictionary(paths.answerPoolFallback, minLength);
      if (!guessDictionary || !answerDictionary) {
        throw new StatsApiError(
          409,
          "Provider artifacts are incomplete. Expected guess and answer pools for that variant."
        );
      }

      const snapshot = languageRegistryStore.upsertProviderLanguageSync({
        variant,
        commit,
        providerId: PROVIDER_ID,
        dictionaryFile: paths.guessPool,
        label: getProviderVariantLabel(variant),
        minLength,
        enabled: true
      });
      rebuildLanguageRuntimeCatalog();

      const entry = snapshot.languages.find((language) => language.id === variant) || null;
      return res.json({
        ok: true,
        action: "enabled",
        variant,
        commit,
        language: entry,
        providers: buildProviderStatusRows()
      });
    } catch (err) {
      return providerAdminError(res, mapRegistryErrorToStats(err));
    }
  });

  router.post("/api/admin/providers/:variant/disable", (req, res) => {
    let variant;
    try {
      variant = parseProviderVariant(req.params.variant);
    } catch (err) {
      return providerAdminError(res, err);
    }

    try {
      const snapshot = languageRegistryStore.setLanguageEnabledSync(variant, false);
      rebuildLanguageRuntimeCatalog();

      const entry = snapshot.languages.find((language) => language.id === variant) || null;
      return res.json({
        ok: true,
        action: "disabled",
        variant,
        language: entry,
        providers: buildProviderStatusRows()
      });
    } catch (err) {
      return providerAdminError(res, mapRegistryErrorToStats(err));
    }
  });

  return router;
}

module.exports = createAdminRouter;
