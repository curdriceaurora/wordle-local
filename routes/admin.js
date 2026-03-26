const express = require("express");

/**
 * Admin routes factory
 * Provides admin UI, provider management, and admin stats endpoints
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
 * @param {Object} deps.providerImportInFlight - Mutable reference to in-flight import state
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
    fetchAndPersistProviderSource,
    persistManualProviderSource,
    buildExpandedFormsArtifacts,
    buildProviderPoolsArtifacts,
    buildFilteredAnswerPoolArtifacts,
    checkProviderUpdate,
    buildProviderArtifactPaths,
    getProviderVariantLabel,
    loadDictionary,
    rebuildLanguageRuntimeCatalog,
    leaderboardStore,
    languageRegistryStore,
    providerImportInFlight,
    PROVIDER_COMMIT_PATTERN,
    PROVIDER_IMPORT_SOURCE_TYPES,
    PROVIDER_MANUAL_MAX_FILE_BYTES,
    PROVIDER_MIN_LENGTH,
    PROVIDER_POLICY_VERSION,
    PROVIDER_ID,
    PROVIDER_REPOSITORY,
    PROVIDERS_ROOT,
    StatsApiError,
    ProviderUpdateCheckError
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

  router.get("/api/admin/providers", (req, res) => {
    return res.json({
      ok: true,
      providers: buildProviderStatusRows()
    });
  });

  router.post("/api/admin/providers/import", async (req, res) => {
    let variant;
    try {
      variant = parseProviderVariant(req.body?.variant);
    } catch (err) {
      return providerAdminError(res, err);
    }

    let sourceType;
    try {
      sourceType = parseProviderImportSource(req.body?.sourceType);
    } catch (err) {
      return providerAdminError(res, err);
    }

    const commitInput = String(req.body?.commit || "").trim();
    if (sourceType === PROVIDER_IMPORT_SOURCE_TYPES.REMOTE_FETCH && !PROVIDER_COMMIT_PATTERN.test(commitInput)) {
      return providerAdminError(
        res,
        new StatsApiError(400, "commit must be a 40-character lowercase hexadecimal git SHA.")
      );
    }
    if (
      sourceType === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD
      && commitInput
      && !PROVIDER_COMMIT_PATTERN.test(commitInput)
    ) {
      return providerAdminError(
        res,
        new StatsApiError(400, "commit must be a 40-character lowercase hexadecimal git SHA when provided.")
      );
    }

    const checksums = req.body?.expectedChecksums;
    const expectedChecksums = {
      dic: String(checksums?.dic || "").trim().toLowerCase(),
      aff: String(checksums?.aff || "").trim().toLowerCase()
    };

    let filterMode;
    try {
      filterMode = parseProviderFilterMode(req.body?.filterMode);
    } catch (err) {
      return providerAdminError(res, err);
    }

    if (providerImportInFlight.value) {
      return providerAdminError(
        res,
        new StatsApiError(
          409,
          `Another import is already running (${providerImportInFlight.value.variant} @ ${providerImportInFlight.value.commit}).`
        )
      );
    }

    const inFlightToken = {
      variant,
      commit: commitInput || "auto",
      startedAt: new Date().toISOString()
    };
    providerImportInFlight.value = inFlightToken;

    try {
      const sourceResult = sourceType === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD
        ? await persistManualProviderSource({
          variant,
          commit: commitInput || null,
          expectedChecksums,
          manualFiles: req.body?.manualFiles,
          maxManualFileBytes: PROVIDER_MANUAL_MAX_FILE_BYTES,
          outputRoot: PROVIDERS_ROOT
        })
        : await fetchAndPersistProviderSource({
          variant,
          commit: commitInput,
          expectedChecksums,
          outputRoot: PROVIDERS_ROOT
        });
      const commit = sourceResult.descriptor.commit;
      const expandedResult = await buildExpandedFormsArtifacts({
        variant,
        commit,
        providerRoot: PROVIDERS_ROOT,
        outputRoot: PROVIDERS_ROOT,
        policyVersion: PROVIDER_POLICY_VERSION
      });
      const poolsResult = await buildProviderPoolsArtifacts({
        variant,
        commit,
        providerRoot: PROVIDERS_ROOT,
        outputRoot: PROVIDERS_ROOT,
        policyVersion: PROVIDER_POLICY_VERSION
      });
      const filteredResult = await buildFilteredAnswerPoolArtifacts({
        variant,
        commit,
        providerRoot: PROVIDERS_ROOT,
        outputRoot: PROVIDERS_ROOT,
        filterMode
      });

      return res.json({
        ok: true,
        action: "imported",
        variant,
        commit,
        sourceType,
        filterMode,
        counts: {
          sourceFiles: {
            dicBytes: sourceResult.sourceFiles.dic.byteSize,
            affBytes: sourceResult.sourceFiles.aff.byteSize
          },
          expandedForms: expandedResult.counts.expandedForms,
          guessPool: poolsResult.counts.expandedForms,
          answerPool: poolsResult.counts.answerPool,
          filteredAnswers: filteredResult.counts.activatedAnswers
        },
        providers: buildProviderStatusRows()
      });
    } catch (err) {
      return providerAdminError(res, mapProviderPipelineError(err));
    } finally {
      if (providerImportInFlight.value === inFlightToken) {
        providerImportInFlight.value = null;
      }
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
