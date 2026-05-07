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
    classesStore,
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
    ClassesStoreError,
    StatsApiError,
    ProviderUpdateCheckError,
    AppConfigStoreError,
    buildCsv,
    parseBulkNames,
    UTF8_BOM,
    normalizeLang,
    getLocalDateString
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
      if (err instanceof LeaderboardStoreError) {
        if (err.code === "MAX_PROFILES_TOO_LOW") {
          return res.status(409).json({ error: err.message });
        }
        if (err.code === "INVALID_REQUEST") {
          return res.status(400).json({ error: err.message });
        }
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

  // ============================================================================
  // CLASSROOM (CLASSES) ROUTES
  // ============================================================================

  function classesStoreErrorToStatus(err) {
    switch (err?.code) {
      case "CLASS_NOT_FOUND":
      case "MEMBER_NOT_FOUND":
        return 404;
      case "DUPLICATE_NAME":
      case "MAX_CLASSES_REACHED":
      case "MAX_MEMBERS_REACHED":
      case "CLASS_ARCHIVED":
        return 409;
      default:
        return 400;
    }
  }

  function handleClassesStoreError(res, err, fallbackLogContext) {
    if (err instanceof ClassesStoreError) {
      return res.status(classesStoreErrorToStatus(err)).json({ error: err.message });
    }
    if (err instanceof StatsApiError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err instanceof LeaderboardStoreError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(fallbackLogContext, err);
    return res.status(503).json({ error: "Class operation unavailable right now. Try again soon." });
  }

  function parseDateString(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day
    ) {
      return null;
    }
    return value;
  }

  function eachDateInRange(fromDate, toDate) {
    const dates = [];
    const start = new Date(`${fromDate}T00:00:00`);
    const end = new Date(`${toDate}T00:00:00`);
    const cursor = new Date(start.getTime());
    while (cursor <= end) {
      const yyyy = cursor.getFullYear();
      const mm = String(cursor.getMonth() + 1).padStart(2, "0");
      const dd = String(cursor.getDate()).padStart(2, "0");
      dates.push(`${yyyy}-${mm}-${dd}`);
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }

  const REPORT_MAX_DAYS = 90;
  const SUPPORTED_BULK_LIMIT = 500;

  function buildReportSummary({ classRecord, profiles, results, dates, lang }) {
    const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
    const rows = [];
    const datePrefix = `|${lang}|`;
    for (const profileId of classRecord.memberProfileIds) {
      const profile = profileMap.get(profileId);
      if (!profile) {
        rows.push({
          profileId,
          name: null,
          missing: true,
          days: dates.map((date) => ({ date, status: "no-profile" }))
        });
        continue;
      }
      const profileResults = results[profileId] || {};
      // Pre-index by date — single pass over the profile's results, regardless
      // of how many dates we then look up. Collisions on the same date+lang
      // (different code suffixes) are resolved deterministically by newest
      // updatedAt.
      const indexByDate = Object.create(null);
      for (const [key, value] of Object.entries(profileResults)) {
        const langSep = key.indexOf("|");
        if (langSep === -1) continue;
        const datePart = key.slice(0, langSep);
        if (!key.startsWith(`${datePart}${datePrefix}`)) continue;
        const existing = indexByDate[datePart];
        if (!existing || (value.updatedAt && value.updatedAt > existing.updatedAt)) {
          indexByDate[datePart] = value;
        }
      }
      const days = dates.map((date) => {
        const entry = indexByDate[date];
        if (!entry) {
          return { date, status: "not-started" };
        }
        return {
          date,
          status: entry.won ? "won" : "lost",
          attempts: entry.won ? entry.attempts : null,
          maxGuesses: entry.maxGuesses,
          submissionCount: entry.submissionCount,
          updatedAt: entry.updatedAt
        };
      });
      const wins = days.filter((day) => day.status === "won").length;
      const playedCount = days.filter((day) => day.status === "won" || day.status === "lost").length;
      rows.push({
        profileId,
        name: profile.name,
        missing: false,
        wins,
        playedCount,
        winRate: playedCount > 0 ? wins / playedCount : 0,
        lastPlayedAt: days.reduce((latest, day) => {
          if (!day.updatedAt) return latest;
          if (!latest || day.updatedAt > latest) return day.updatedAt;
          return latest;
        }, null),
        days
      });
    }
    return rows;
  }

  function rowsToCsv({ dates, rows, lang }) {
    const header = ["profile_id", "profile_name", "lang"];
    for (const date of dates) {
      header.push(`${date}_status`, `${date}_attempts`);
    }
    header.push("wins_in_range", "played_in_range", "win_rate_in_range", "last_played_at");
    const csvRows = [header];
    for (const row of rows) {
      const flat = [row.profileId, row.name || "", lang];
      for (const day of row.days) {
        flat.push(day.status, day.attempts === null || day.attempts === undefined ? "" : String(day.attempts));
      }
      flat.push(
        row.missing ? "" : String(row.wins ?? 0),
        row.missing ? "" : String(row.playedCount ?? 0),
        row.missing
          ? ""
          : (row.winRate !== null && row.winRate !== undefined ? row.winRate.toFixed(4) : ""),
        row.lastPlayedAt || ""
      );
      csvRows.push(flat);
    }
    return buildCsv(csvRows);
  }

  router.get("/api/admin/classes", async (req, res) => {
    try {
      const includeArchived = String(req.query?.includeArchived || "").toLowerCase() === "true";
      const list = await classesStore.listClasses({ includeArchived });
      return res.json({
        ok: true,
        classes: list.map((entry) => ({
          id: entry.id,
          name: entry.name,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          archivedAt: entry.archivedAt,
          memberCount: entry.memberProfileIds.length
        }))
      });
    } catch (err) {
      return handleClassesStoreError(res, err, "Class list failed.");
    }
  });

  router.post("/api/admin/classes", async (req, res) => {
    const name = req.body?.name;
    try {
      const created = await classesStore.createClass(name);
      return res.status(201).json({
        ok: true,
        class: {
          id: created.id,
          name: created.name,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          archivedAt: created.archivedAt,
          memberCount: 0
        }
      });
    } catch (err) {
      return handleClassesStoreError(res, err, "Class create failed.");
    }
  });

  router.get("/api/admin/classes/:id", async (req, res) => {
    const classId = String(req.params.id || "").trim();
    if (!classId) {
      return res.status(400).json({ error: "Class id is required." });
    }
    try {
      const classRecord = await classesStore.getClass(classId);
      if (!classRecord) {
        return res.status(404).json({ error: "Class not found." });
      }
      const leaderboard = await leaderboardStore.getSnapshot();
      const profileMap = new Map(leaderboard.profiles.map((profile) => [profile.id, profile]));
      const members = classRecord.memberProfileIds.map((profileId) => {
        const profile = profileMap.get(profileId);
        return {
          profileId,
          name: profile?.name ?? null,
          missing: !profile
        };
      });
      return res.json({
        ok: true,
        class: {
          ...classRecord,
          memberCount: classRecord.memberProfileIds.length
        },
        members
      });
    } catch (err) {
      return handleClassesStoreError(res, err, "Class detail failed.");
    }
  });

  router.patch("/api/admin/classes/:id", async (req, res) => {
    const classId = String(req.params.id || "").trim();
    if (!classId) {
      return res.status(400).json({ error: "Class id is required." });
    }
    const patch = {};
    if (req.body?.name !== undefined) patch.name = req.body.name;
    if (req.body?.archived !== undefined) patch.archived = req.body.archived;
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "Provide at least one of: name, archived." });
    }
    try {
      const updated = await classesStore.updateClass(classId, patch);
      return res.json({
        ok: true,
        class: {
          id: updated.id,
          name: updated.name,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
          archivedAt: updated.archivedAt,
          memberCount: updated.memberProfileIds.length
        }
      });
    } catch (err) {
      return handleClassesStoreError(res, err, "Class update failed.");
    }
  });

  router.delete("/api/admin/classes/:id", async (req, res) => {
    const classId = String(req.params.id || "").trim();
    if (!classId) {
      return res.status(400).json({ error: "Class id is required." });
    }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: "confirmed=true is required to delete a class." });
    }
    const deleteProfilesFlag = req.body?.deleteProfiles === true;

    try {
      let carveOutIds = [];
      let removedProfileIds = [];
      if (deleteProfilesFlag) {
        // Atomic in classes-store: drops the class, computes which member
        // IDs are NOT in any other non-archived class, and removes those
        // from every (archived) class that still references them. The
        // classes-side state is consistent before we touch the leaderboard.
        const result = await classesStore.deleteClassWithCarveOut(classId);
        carveOutIds = result.carveOutIds;

        if (carveOutIds.length > 0) {
          await leaderboardStore.mutate((draft) => {
            for (const memberId of carveOutIds) {
              const idx = draft.profiles.findIndex((profile) => profile.id === memberId);
              if (idx !== -1) {
                draft.profiles.splice(idx, 1);
                if (
                  draft.resultsByProfile
                  && Object.prototype.hasOwnProperty.call(draft.resultsByProfile, memberId)
                ) {
                  delete draft.resultsByProfile[memberId];
                }
                removedProfileIds.push(memberId);
              }
            }
          });
        }
      } else {
        // Just delete the class without touching profiles.
        await classesStore.deleteClass(classId);
      }
      return res.json({
        ok: true,
        deletedClassId: classId,
        deletedProfileIds: removedProfileIds
      });
    } catch (err) {
      return handleClassesStoreError(res, err, "Class delete failed.");
    }
  });

  router.post("/api/admin/classes/:id/members/bulk", async (req, res) => {
    const classId = String(req.params.id || "").trim();
    if (!classId) {
      return res.status(400).json({ error: "Class id is required." });
    }
    let target;
    try {
      target = await classesStore.getClass(classId);
    } catch (err) {
      return handleClassesStoreError(res, err, "Class lookup failed.");
    }
    if (!target) {
      return res.status(404).json({ error: "Class not found." });
    }
    if (target.archivedAt) {
      return res.status(409).json({
        error: "Cannot bulk-add to an archived class. Unarchive it first."
      });
    }

    let candidateNames = [];
    let parseErrors = [];
    if (Array.isArray(req.body?.names)) {
      candidateNames = req.body.names;
    } else if (typeof req.body?.csv === "string") {
      const parsed = parseBulkNames(req.body.csv, { lineLimit: SUPPORTED_BULK_LIMIT });
      candidateNames = parsed.names;
      parseErrors = parsed.errors;
    } else {
      return res.status(400).json({
        error: "Provide either { names: string[] } or { csv: string }."
      });
    }

    if (parseErrors.length > 0) {
      return res.status(400).json({
        error: "Bulk input could not be parsed.",
        parseErrors
      });
    }

    if (candidateNames.length === 0) {
      return res.json({
        ok: true,
        addedToClass: [],
        createdProfileIds: [],
        reusedProfileIds: [],
        classMemberCount: target.memberProfileIds.length
      });
    }
    if (candidateNames.length > SUPPORTED_BULK_LIMIT) {
      return res.status(413).json({
        error: `Bulk input exceeded ${SUPPORTED_BULK_LIMIT} names per request.`
      });
    }

    const normalizedNames = [];
    const invalidNames = [];
    const dedupedLowerSet = new Set();
    for (const candidate of candidateNames) {
      try {
        const next = normalizeProfileNameInput(candidate);
        const key = next.toLowerCase();
        if (!dedupedLowerSet.has(key)) {
          dedupedLowerSet.add(key);
          normalizedNames.push(next);
        }
      } catch (err) {
        invalidNames.push({ raw: candidate, error: err?.message || "Invalid name." });
      }
    }
    if (invalidNames.length > 0) {
      return res.status(400).json({
        error: "One or more names did not pass validation.",
        invalidNames
      });
    }

    // Pre-validate the per-class member cap with an upper bound. If even the
    // best-case (all reused profiles) would exceed the cap, reject before we
    // touch the leaderboard so a class-side failure can't leave orphan
    // profile records.
    const projectedMembers = target.memberProfileIds.length + normalizedNames.length;
    if (projectedMembers > classesStore.maxMembersPerClass) {
      return res.status(409).json({
        error: `Class is at the per-class member cap of ${classesStore.maxMembersPerClass}.`
      });
    }

    // Resolve each name to an existing profile (case-insensitive match) or
    // create a new profile inside a single mutate so we never half-write.
    // The mutate's normalizer can prune the oldest profiles past the
    // leaderboard cap — including pre-existing class members — so we
    // (1) filter the current bulk's resolved IDs against the surviving set
    // before adding to the class, and (2) reconcile every class against the
    // surviving set so previously-tracked members that were pruned away
    // don't remain as dead references.
    const resolvedProfileIds = [];
    const intendedReused = [];
    const intendedCreated = [];
    const { randomUUID } = require("node:crypto");
    let persistedSnapshot;
    try {
      persistedSnapshot = await leaderboardStore.mutate((draft) => {
        const nowIso = new Date().toISOString();
        const existingByLowerName = new Map(
          draft.profiles.map((profile) => [profile.name.toLowerCase(), profile])
        );
        for (const name of normalizedNames) {
          const key = name.toLowerCase();
          const existing = existingByLowerName.get(key);
          if (existing) {
            resolvedProfileIds.push(existing.id);
            intendedReused.push(existing.id);
            continue;
          }
          const created = {
            id: randomUUID(),
            name,
            createdAt: nowIso,
            updatedAt: nowIso
          };
          draft.profiles.push(created);
          existingByLowerName.set(key, created);
          resolvedProfileIds.push(created.id);
          intendedCreated.push(created.id);
        }
      });
    } catch (err) {
      return handleClassesStoreError(res, err, "Bulk profile resolution failed.");
    }

    const survivingProfileIds = new Set(
      persistedSnapshot.profiles.map((profile) => profile.id)
    );
    const survivors = resolvedProfileIds.filter((id) => survivingProfileIds.has(id));
    const droppedDueToCap = resolvedProfileIds.filter((id) => !survivingProfileIds.has(id));
    const reusedProfileIds = intendedReused.filter((id) => survivingProfileIds.has(id));
    const createdProfileIds = intendedCreated.filter((id) => survivingProfileIds.has(id));

    // Reconcile every class against the persisted leaderboard so any
    // pre-existing class member that the cap-pruner just dropped is
    // removed from class rosters atomically. Without this, class
    // detail/report could surface "(missing profile)" rows immediately
    // after a successful bulk-add that crossed the cap.
    let reconciliationDrops = [];
    try {
      reconciliationDrops = await classesStore.reconcileMissingProfiles(survivingProfileIds);
    } catch (err) {
      return handleClassesStoreError(res, err, "Class reconciliation after bulk add failed.");
    }

    let addOutcome;
    try {
      addOutcome = await classesStore.addMembers(classId, survivors);
    } catch (err) {
      return handleClassesStoreError(res, err, "Bulk class add failed.");
    }

    const responseBody = {
      ok: true,
      addedToClass: addOutcome.added,
      createdProfileIds,
      reusedProfileIds,
      classMemberCount: addOutcome.class.memberProfileIds.length
    };
    if (droppedDueToCap.length > 0) {
      responseBody.droppedDueToCap = droppedDueToCap.length;
    }
    if (reconciliationDrops.length > 0) {
      responseBody.reconciledClasses = reconciliationDrops.map((entry) => ({
        classId: entry.classId,
        removedProfileIds: entry.removedProfileIds
      }));
    }
    return res.json(responseBody);
  });

  router.delete("/api/admin/classes/:id/members/:profileId", async (req, res) => {
    const classId = String(req.params.id || "").trim();
    const profileId = String(req.params.profileId || "").trim();
    if (!classId || !profileId) {
      return res.status(400).json({ error: "Class id and profile id are required." });
    }
    try {
      const updated = await classesStore.removeMember(classId, profileId);
      return res.json({
        ok: true,
        class: {
          id: updated.id,
          memberCount: updated.memberProfileIds.length
        }
      });
    } catch (err) {
      return handleClassesStoreError(res, err, "Class member removal failed.");
    }
  });

  router.get("/api/admin/classes/:id/report", async (req, res) => {
    const classId = String(req.params.id || "").trim();
    if (!classId) {
      return res.status(400).json({ error: "Class id is required." });
    }
    const rawLang = String(req.query?.lang || "").trim();
    if (!rawLang) {
      return res.status(400).json({ error: "lang query parameter is required." });
    }
    const lang = normalizeLang(rawLang);
    if (!lang) {
      return res.status(400).json({
        error: `lang "${rawLang}" is not registered on this host.`
      });
    }

    const today = getLocalDateString(new Date());
    const rawFrom = req.query?.from;
    const rawTo = req.query?.to;
    if (rawFrom !== undefined && parseDateString(rawFrom) === null) {
      return res.status(400).json({ error: "`from` must be a YYYY-MM-DD date." });
    }
    if (rawTo !== undefined && parseDateString(rawTo) === null) {
      return res.status(400).json({ error: "`to` must be a YYYY-MM-DD date." });
    }
    const fromDate = parseDateString(rawFrom) || today;
    const toDate = parseDateString(rawTo) || fromDate;
    if (fromDate > toDate) {
      return res.status(400).json({ error: "`from` must be on or before `to`." });
    }
    const dates = eachDateInRange(fromDate, toDate);
    if (dates.length > REPORT_MAX_DAYS) {
      return res.status(400).json({
        error: `Date range exceeds the ${REPORT_MAX_DAYS}-day cap.`
      });
    }

    const format = String(req.query?.format || "json").trim().toLowerCase();
    if (format !== "json" && format !== "csv") {
      return res.status(400).json({ error: "format must be \"json\" or \"csv\"." });
    }
    const wantBom = String(req.query?.bom || "").toLowerCase() === "true";

    let classRecord;
    let leaderboardSnapshot;
    try {
      classRecord = await classesStore.getClass(classId);
      if (!classRecord) {
        return res.status(404).json({ error: "Class not found." });
      }
      leaderboardSnapshot = await leaderboardStore.getSnapshot();
    } catch (err) {
      return handleClassesStoreError(res, err, "Class report failed.");
    }

    const rows = buildReportSummary({
      classRecord,
      profiles: leaderboardSnapshot.profiles,
      results: leaderboardSnapshot.resultsByProfile || {},
      dates,
      lang
    });

    if (format === "csv") {
      const csv = rowsToCsv({ dates, rows, lang });
      const filename = `class-${classRecord.id}-report-${fromDate}-${toDate}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      const body = wantBom ? `${UTF8_BOM}${csv}` : csv;
      return res.send(body);
    }

    return res.json({
      ok: true,
      class: {
        id: classRecord.id,
        name: classRecord.name
      },
      lang,
      from: fromDate,
      to: toDate,
      dates,
      rows
    });
  });

  return router;
}

module.exports = createAdminRouter;
