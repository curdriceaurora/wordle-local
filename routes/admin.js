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
    providerImportEnqueueActiveRef,
    dataMutationLockRef,
    restoreInProgressRef,
    claimDirectDataWriteSlot,
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
    getLocalDateString,
    aggregateAnalytics,
    analyticsCacheTtlMs,
    analyticsTimezone,
    scheduleStore,
    runSchedulerReconcile,
    ScheduleStoreError,
    webhookStore,
    webhookDeliveryStore,
    webhookService,
    WebhookStoreError,
    WebhookDeliveryStoreError,
    redactWebhookSecret,
    webhooksEnabled,
    webhookDefaultMaxAttempts,
    pushSubscriptionStore,
    notificationService,
    PushSubscriptionStoreError,
    challengeConfigStore,
    challengeResultsStore,
    challengeEngine,
    ChallengeConfigStoreError,
    ChallengeResultsStoreError,
    challengeModeEnabled,
    challengeMaxTimeBudgetSeconds,
    challengeMaxPuzzles
  } = deps;

  // Required dep — the toggle and runtime-config handlers depend on
  // it to close the restore/direct-write TOCTOU. The earlier defensive
  // `typeof === "function"` fallbacks would have degraded silently to
  // a no-op release fn if a stale server.js failed to inject this,
  // re-introducing the very race we documented. Fail loudly at wiring
  // time so the bug surfaces in tests, not in production under load.
  if (typeof claimDirectDataWriteSlot !== "function") {
    throw new TypeError("createAdminRouter: claimDirectDataWriteSlot dep is required.");
  }
  if (typeof aggregateAnalytics !== "function") {
    throw new TypeError("createAdminRouter: aggregateAnalytics dep is required.");
  }
  if (!scheduleStore || typeof scheduleStore.load !== "function") {
    throw new TypeError("createAdminRouter: scheduleStore dep is required.");
  }
  if (typeof runSchedulerReconcile !== "function") {
    throw new TypeError("createAdminRouter: runSchedulerReconcile dep is required.");
  }
  if (!ScheduleStoreError) {
    throw new TypeError("createAdminRouter: ScheduleStoreError dep is required.");
  }

  // Map a ScheduleStoreError code to an HTTP status. 400 covers shape /
  // validation failures; 404 for entry-not-found; 409 for duplicates;
  // 503 for store-level read/write failures so clients can retry.
  function scheduleErrorStatus(err) {
    if (!(err instanceof ScheduleStoreError)) return 500;
    switch (err.code) {
      case "INVALID_REQUEST":
      case "INVALID_DATE":
      case "INVALID_WORD":
      case "INVALID_LANG":
      case "INVALID_NOTES":
      case "INVALID_TIMEZONE":
      case "INVALID_SCHEDULE":
      case "INVALID_ENTRY":
      case "VERSION_UNSUPPORTED":
        return 400;
      case "ENTRY_NOT_FOUND":
        return 404;
      case "DUPLICATE_ENTRY":
        return 409;
      case "STORE_READ_FAILED":
      case "STORE_WRITE_FAILED":
      case "STORE_PARSE_FAILED":
        return 503;
      default:
        return 500;
    }
  }
  function scheduleErrorBody(err) {
    // Store-level errors include absolute file paths and raw fs error
    // text in their message (useful in server logs, not in responses).
    // Substitute generic copy for those codes; pass the validation /
    // shape errors through verbatim because they're authored by us
    // and don't contain secrets.
    const STORE_LEVEL = new Set([
      "STORE_READ_FAILED",
      "STORE_WRITE_FAILED",
      "STORE_PARSE_FAILED"
    ]);
    const code = err?.code || "INTERNAL";
    const message = STORE_LEVEL.has(code)
      ? "Schedule store unavailable. See server logs."
      : err?.message || "Schedule operation failed.";
    return { error: message, code };
  }
  function scheduleAudit(action, fields) {
    // Single-line audit log entry per write. `actor` is intentionally a
    // fingerprint of the admin key (first 12 hex chars of sha256) so the
    // log doesn't contain the secret itself; the requireAdminAccess
    // middleware already attaches the raw key on req for the duration of
    // the request, and we hash here at the call site.
    try {
      console.log(JSON.stringify({
        event: `[schedule] ${action}`,
        ts: new Date().toISOString(),
        ...fields
      }));
    } catch (_err) {
      // best-effort; never block a write on logging failure
    }
  }
  function actorFingerprint(req) {
    const key = req?.headers?.["x-admin-key"];
    if (typeof key !== "string" || !key) return "unknown";
    const crypto = require("node:crypto");
    return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
  }

  const router = express.Router();

  // Per-router analytics cache. Keyed by
  // `(window | snapshot.updatedAt | today)` so any leaderboard mutation
  // invalidates instantly via the snapshot's own updatedAt bump, and the
  // entry naturally falls off the server-local day boundary so a
  // pre-midnight payload never serves a post-midnight request even when
  // the snapshot is otherwise unchanged. The TTL is a coarse second-tier
  // guard for stretches with no writes and no day rollover.
  const analyticsCache = new Map();
  const ANALYTICS_CACHE_TTL = Number.isInteger(analyticsCacheTtlMs) && analyticsCacheTtlMs > 0
    ? analyticsCacheTtlMs
    : 60 * 1000;
  const ANALYTICS_TZ = (typeof analyticsTimezone === "string" && analyticsTimezone)
    ? analyticsTimezone
    : "UTC";

  // ANALYTICS_TZ controls hour-of-day bucketing only — NOT the date math
  // that defines window edges. The game stores daily-key dates via
  // getLocalDateString(new Date()), i.e. the server's local timezone. If
  // we computed "today" in a different zone, the aggregator's "today"
  // could disagree with the dates the storage actually uses, leaving the
  // most recent plays bucketed under "yesterday" from the dashboard's
  // perspective. Aligning "today" with the storage convention is the
  // important invariant; ANALYTICS_TZ still gives operators meaningful
  // hour-of-day buckets in their preferred zone (it's purely display).
  function todayForAnalytics(now = new Date()) {
    return getLocalDateString(now);
  }

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

  router.get("/api/admin/analytics", async (req, res) => {
    const rawWindow = typeof req.query.window === "string" ? req.query.window : "";
    const windowName = rawWindow === "" ? "7d" : rawWindow;
    if (!["7d", "30d", "all"].includes(windowName)) {
      return res.status(400).json({
        error: "window must be one of 7d, 30d, all.",
        code: "INVALID_WINDOW"
      });
    }

    let snapshot;
    try {
      snapshot = await leaderboardStore.getSnapshot();
    } catch (err) {
      console.error("Analytics snapshot read failed.", err);
      return res.status(503).json({
        error: "Analytics unavailable right now. Try again soon."
      });
    }

    // Capture a single Date and reuse it for the server-local "today"
    // string AND the generatedAt timestamp. Two separate new Date() calls
    // could straddle midnight server-side in rare cases, leaving the
    // payload internally inconsistent (e.g. window dates from yesterday
    // but generatedAt from today). Resolving today first also lets the
    // cache key include it so the stored payload naturally falls off the
    // server-local day boundary — matching the storage convention the
    // game uses when writing daily-key dates — even when the snapshot
    // and TTL haven't budged.
    const nowDate = new Date();
    const today = todayForAnalytics(nowDate);
    const cacheKey = `${windowName}|${snapshot.updatedAt || ""}|${today}`;
    const now = nowDate.getTime();
    const cached = analyticsCache.get(cacheKey);
    if (cached && now - cached.cachedAt < ANALYTICS_CACHE_TTL) {
      res.setHeader("X-Analytics-Cache", "HIT");
      return res.json(cached.payload);
    }

    let payload;
    try {
      payload = aggregateAnalytics(snapshot, {
        window: windowName,
        today,
        tz: ANALYTICS_TZ,
        generatedAt: nowDate.toISOString()
      });
    } catch (err) {
      // 503 (not 500) so clients with retry semantics treat this as
      // transient unavailability — matches the snapshot-read failure
      // branch above and the rest of the admin endpoints.
      console.error("Analytics aggregation failed.", err);
      return res.status(503).json({
        error: "Analytics aggregation failed."
      });
    }

    // Bound cache size: keep at most 6 entries (3 windows × ~2 mtime
    // bumps of headroom). Evict before insert and loop until under cap
    // so the post-insert size never exceeds the bound. The earlier
    // `> 6` form let the map grow to 7 before evicting one — fine in
    // practice but contradicts the comment.
    while (analyticsCache.size >= 6) {
      const oldestKey = analyticsCache.keys().next().value;
      if (oldestKey === undefined) break;
      analyticsCache.delete(oldestKey);
    }
    analyticsCache.set(cacheKey, { cachedAt: now, payload });
    res.setHeader("X-Analytics-Cache", "MISS");
    return res.json(payload);
  });

  // ============================================================================
  // SCHEDULE ROUTES — daily-word scheduler
  // ============================================================================

  router.get("/api/admin/schedule", async (req, res) => {
    try {
      const snapshot = await scheduleStore.getSnapshot();
      return res.json(snapshot);
    } catch (err) {
      if (err instanceof ScheduleStoreError) {
        return res.status(scheduleErrorStatus(err)).json(scheduleErrorBody(err));
      }
      console.error("[schedule] read failed:", err);
      return res.status(503).json({
        error: "Schedule read failed.",
        code: "STORE_READ_FAILED"
      });
    }
  });

  // Schedule mutations also write to data/. Without this slot a concurrent
  // backup/restore can race them — the existing /api gate only blocks
  // request handlers from observing the lock, but it doesn't serialize
  // direct writes against the lock holder. Same pattern as POST /api/word
  // and PUT /api/admin/runtime-config.
  async function withSlot(handler) {
    const releaseSlot = await claimDirectDataWriteSlot();
    try {
      return await handler();
    } finally {
      releaseSlot();
    }
  }

  router.post("/api/admin/schedule/entries", async (req, res) => {
    const overwriteFlag = String(req.query.overwrite || "").toLowerCase() === "true";
    try {
      const result = await withSlot(async () => {
        return scheduleStore.addEntry(req.body || {}, { overwrite: overwriteFlag });
      });
      scheduleAudit("entries.add", {
        actor: actorFingerprint(req),
        date: result.entry.date,
        lang: result.entry.lang,
        replaced: result.replaced
      });
      return res.status(result.replaced ? 200 : 201).json({
        ok: true,
        entry: result.entry,
        replaced: result.replaced,
        schedule: result.schedule
      });
    } catch (err) {
      if (err instanceof ScheduleStoreError) {
        return res.status(scheduleErrorStatus(err)).json(scheduleErrorBody(err));
      }
      console.error("[schedule] add entry failed:", err);
      return res.status(503).json({
        error: "Schedule write failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.put("/api/admin/schedule/entries/:date/:lang", async (req, res) => {
    try {
      const result = await withSlot(async () => {
        return scheduleStore.updateEntry(req.params.date, req.params.lang, req.body || {});
      });
      scheduleAudit("entries.update", {
        actor: actorFingerprint(req),
        date: req.params.date,
        lang: req.params.lang
      });
      return res.json({ ok: true, entry: result.entry, schedule: result.schedule });
    } catch (err) {
      if (err instanceof ScheduleStoreError) {
        return res.status(scheduleErrorStatus(err)).json(scheduleErrorBody(err));
      }
      console.error("[schedule] update entry failed:", err);
      return res.status(503).json({
        error: "Schedule write failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.delete("/api/admin/schedule/entries/:date/:lang", async (req, res) => {
    try {
      await withSlot(async () => {
        return scheduleStore.removeEntry(req.params.date, req.params.lang);
      });
      scheduleAudit("entries.delete", {
        actor: actorFingerprint(req),
        date: req.params.date,
        lang: req.params.lang
      });
      return res.status(204).send();
    } catch (err) {
      if (err instanceof ScheduleStoreError) {
        return res.status(scheduleErrorStatus(err)).json(scheduleErrorBody(err));
      }
      console.error("[schedule] delete entry failed:", err);
      return res.status(503).json({
        error: "Schedule write failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.put("/api/admin/schedule/config", async (req, res) => {
    try {
      const result = await withSlot(async () => {
        const before = await scheduleStore.getSnapshot();
        const next = await scheduleStore.setConfig(req.body || {});
        return { before, next };
      });
      scheduleAudit("config.update", {
        actor: actorFingerprint(req),
        before: {
          timezone: result.before.timezone,
          auto_rotate: result.before.auto_rotate,
          retention_days: result.before.retention_days
        },
        after: {
          timezone: result.next.timezone,
          auto_rotate: result.next.auto_rotate,
          retention_days: result.next.retention_days
        }
      });
      return res.json({ ok: true, schedule: result.next });
    } catch (err) {
      if (err instanceof ScheduleStoreError) {
        return res.status(scheduleErrorStatus(err)).json(scheduleErrorBody(err));
      }
      console.error("[schedule] config update failed:", err);
      return res.status(503).json({
        error: "Schedule config update failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.post("/api/admin/schedule/prune", async (req, res) => {
    try {
      const result = await withSlot(async () => {
        const snapshot = await scheduleStore.getSnapshot();
        // Compute the cutoff in the schedule's own zone — if we used
        // server-local "today" minus retention_days here we'd inadvertently
        // shift the cutoff away from the dates the entries are keyed by.
        // Build YYYY-MM-DD via formatToParts because Intl.DateTimeFormat
        // .format() output isn't a stable machine-readable layout across
        // runtimes (en-CA can swap variants, etc.).
        const dtf = new Intl.DateTimeFormat("en-CA", {
          timeZone: snapshot.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        });
        const parts = dtf.formatToParts(new Date());
        const y = parseInt(parts.find((p) => p.type === "year")?.value, 10);
        const m = parseInt(parts.find((p) => p.type === "month")?.value, 10);
        const d = parseInt(parts.find((p) => p.type === "day")?.value, 10);
        if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
          throw new ScheduleStoreError(
            "INVALID_REQUEST",
            `Could not derive today's date in zone ${snapshot.timezone}.`
          );
        }
        const cutoffMs = Date.UTC(y, m - 1, d) - snapshot.retention_days * 24 * 60 * 60 * 1000;
        const cutoff = new Date(cutoffMs);
        const cutoffStr = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}-${String(cutoff.getUTCDate()).padStart(2, "0")}`;
        const out = await scheduleStore.pruneBefore(cutoffStr);
        return { cutoffStr, pruned: out.pruned };
      });
      scheduleAudit("prune", {
        actor: actorFingerprint(req),
        cutoff: result.cutoffStr,
        pruned: result.pruned
      });
      return res.json({ ok: true, pruned: result.pruned, cutoff: result.cutoffStr });
    } catch (err) {
      if (err instanceof ScheduleStoreError) {
        return res.status(scheduleErrorStatus(err)).json(scheduleErrorBody(err));
      }
      console.error("[schedule] prune failed:", err);
      return res.status(503).json({
        error: "Schedule prune failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.post("/api/admin/schedule/reconcile", async (req, res) => {
    // No outer withSlot here: runSchedulerReconcile claims the slot
    // internally. Wrapping again would just bump the counter twice and
    // the inner release would precede the outer one, which the
    // counter-based claim handles correctly but adds no value.
    try {
      const result = await runSchedulerReconcile("admin-trigger");
      scheduleAudit("reconcile.manual", {
        actor: actorFingerprint(req),
        action: result?.action || "noop",
        todayLocal: result?.todayLocal || null
      });
      return res.json({ ok: true, result });
    } catch (err) {
      console.error("[schedule] manual reconcile failed:", err);
      return res.status(503).json({
        error: "Manual reconcile failed.",
        code: "RECONCILE_FAILED"
      });
    }
  });

  // ── Webhooks ────────────────────────────────────────────────────────
  // Map a WebhookStoreError code to an HTTP status. 400 covers shape /
  // validation failures, 404 for not-found, 503 for store I/O failures.
  function webhookErrorStatus(err) {
    if (err instanceof WebhookStoreError || err instanceof WebhookDeliveryStoreError) {
      switch (err.code) {
        case "INVALID_REQUEST":
        case "INVALID_URL":
        case "INVALID_EVENTS":
        case "INVALID_LABEL":
        case "INVALID_MAX_ATTEMPTS":
        case "INVALID_SUBSCRIPTION":
        case "INVALID_DELIVERY":
        case "INVALID_STORE":
        case "VERSION_UNSUPPORTED":
          return 400;
        case "SUBSCRIPTION_NOT_FOUND":
        case "DELIVERY_NOT_FOUND":
          return 404;
        case "STORE_READ_FAILED":
        case "STORE_WRITE_FAILED":
        case "STORE_PARSE_FAILED":
          return 503;
        default:
          return 500;
      }
    }
    return 500;
  }
  function webhookErrorBody(err) {
    const STORE_LEVEL = new Set([
      "STORE_READ_FAILED",
      "STORE_WRITE_FAILED",
      "STORE_PARSE_FAILED"
    ]);
    const code = err?.code || "INTERNAL";
    const message = STORE_LEVEL.has(code)
      ? "Webhook store unavailable. See server logs."
      : err?.message || "Webhook operation failed.";
    return { error: message, code };
  }
  function webhookAudit(action, fields) {
    try {
      console.log(JSON.stringify({
        event: `[webhook] ${action}`,
        ts: new Date().toISOString(),
        ...fields
      }));
    } catch (_err) {
      // best-effort
    }
  }
  function ensureWebhookDeps() {
    if (!webhookStore || typeof webhookStore.load !== "function") {
      throw new TypeError("createAdminRouter: webhookStore dep is required.");
    }
    if (!webhookDeliveryStore || typeof webhookDeliveryStore.load !== "function") {
      throw new TypeError("createAdminRouter: webhookDeliveryStore dep is required.");
    }
    if (!webhookService) {
      throw new TypeError("createAdminRouter: webhookService dep is required.");
    }
    if (!WebhookStoreError) {
      throw new TypeError("createAdminRouter: WebhookStoreError dep is required.");
    }
    if (!WebhookDeliveryStoreError) {
      throw new TypeError("createAdminRouter: WebhookDeliveryStoreError dep is required.");
    }
    if (typeof redactWebhookSecret !== "function") {
      throw new TypeError("createAdminRouter: redactWebhookSecret dep is required.");
    }
  }
  ensureWebhookDeps();

  router.get("/api/admin/webhooks", async (req, res) => {
    try {
      const snapshot = await webhookStore.getSnapshot();
      const subscriptions = snapshot.subscriptions.map((sub) => redactWebhookSecret(sub));
      return res.json({
        ok: true,
        enabled: webhooksEnabled !== false,
        subscriptions,
        defaultMaxAttempts: webhookDefaultMaxAttempts
      });
    } catch (err) {
      if (err instanceof WebhookStoreError) {
        return res.status(webhookErrorStatus(err)).json(webhookErrorBody(err));
      }
      console.error("[webhook] list failed:", err);
      return res.status(503).json({
        error: "Webhook list failed.",
        code: "STORE_READ_FAILED"
      });
    }
  });

  router.post("/api/admin/webhooks", async (req, res) => {
    try {
      const created = await withSlot(async () => {
        return webhookStore.create({
          url: req.body?.url,
          events: req.body?.events,
          enabled: req.body?.enabled !== false,
          maxAttempts: req.body?.maxAttempts,
          label: req.body?.label
        });
      });
      webhookAudit("subscription.create", {
        actor: actorFingerprint(req),
        id: created.id,
        events: created.events,
        url: created.url
      });
      // Return the secret ONCE on creation. Subsequent reads redact it
      // so the operator must rotate-and-fetch to retrieve it again.
      return res.status(201).json({ ok: true, subscription: created });
    } catch (err) {
      if (err instanceof WebhookStoreError) {
        return res.status(webhookErrorStatus(err)).json(webhookErrorBody(err));
      }
      console.error("[webhook] create failed:", err);
      return res.status(503).json({
        error: "Webhook create failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.patch("/api/admin/webhooks/:id", async (req, res) => {
    try {
      const result = await withSlot(async () => {
        return webhookStore.update(req.params.id, req.body || {});
      });
      const rotated = req.body?.rotateSecret === true;
      webhookAudit("subscription.update", {
        actor: actorFingerprint(req),
        id: result.id,
        rotated
      });
      // If rotateSecret was requested, reveal the new secret in the
      // response (one-time view); otherwise redact.
      const payload = rotated ? result : redactWebhookSecret(result);
      return res.json({ ok: true, subscription: payload });
    } catch (err) {
      if (err instanceof WebhookStoreError) {
        return res.status(webhookErrorStatus(err)).json(webhookErrorBody(err));
      }
      console.error("[webhook] update failed:", err);
      return res.status(503).json({
        error: "Webhook update failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.delete("/api/admin/webhooks/:id", async (req, res) => {
    try {
      await withSlot(async () => {
        await webhookStore.remove(req.params.id);
        // Best-effort cascade: delivery rows for the removed
        // subscription have no admin UI to inspect anyway.
        await webhookDeliveryStore.deleteForSubscription(req.params.id).catch((cascadeErr) => {
          // Pass id as a separate arg (not interpolated) so a hostile
          // path param can't inject %s-style format placeholders into
          // the format string. The store's pattern check rejects ids
          // outside [A-Za-z0-9_-], but defense in depth.
          console.warn(
            "[webhook] could not cascade-delete deliveries for %s:",
            req.params.id,
            cascadeErr.message
          );
        });
      });
      webhookAudit("subscription.delete", {
        actor: actorFingerprint(req),
        id: req.params.id
      });
      return res.status(204).send();
    } catch (err) {
      if (err instanceof WebhookStoreError) {
        return res.status(webhookErrorStatus(err)).json(webhookErrorBody(err));
      }
      console.error("[webhook] delete failed:", err);
      return res.status(503).json({
        error: "Webhook delete failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.post("/api/admin/webhooks/:id/test", async (req, res) => {
    if (!webhooksEnabled) {
      return res.status(409).json({
        error: "Webhooks are disabled at the server level (WEBHOOKS_ENABLED=false). Cannot fire test events.",
        code: "WEBHOOKS_DISABLED"
      });
    }
    try {
      const sub = await webhookStore.findById(req.params.id);
      if (!sub) {
        return res.status(404).json({
          error: `No subscription with id ${req.params.id}.`,
          code: "SUBSCRIPTION_NOT_FOUND"
        });
      }
      // Synthesize a queued delivery for the test event. We use the
      // same emit() path so signature, headers, and store rows match
      // what a real provider event would look like — operators
      // verifying their endpoint should see exactly what production
      // payloads will send.
      const testPayload = {
        message: "Test event from local-hosted-wordle admin.",
        subscriptionId: sub.id,
        requestedAt: new Date().toISOString()
      };
      const delivery = await withSlot(async () => {
        return webhookDeliveryStore.enqueue({
          subscriptionId: sub.id,
          event: "webhook.test",
          url: sub.url,
          payload: testPayload
        });
      });
      webhookService.scheduleDelivery(delivery.id, 0, {
        event: "webhook.test",
        payload: testPayload,
        subscription: sub
      });
      webhookAudit("subscription.test", {
        actor: actorFingerprint(req),
        id: sub.id,
        deliveryId: delivery.id
      });
      return res.status(202).json({ ok: true, deliveryId: delivery.id });
    } catch (err) {
      if (err instanceof WebhookStoreError || err instanceof WebhookDeliveryStoreError) {
        return res.status(webhookErrorStatus(err)).json(webhookErrorBody(err));
      }
      console.error("[webhook] test failed:", err);
      return res.status(503).json({
        error: "Webhook test failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.get("/api/admin/webhooks/:id/deliveries", async (req, res) => {
    try {
      const limitRaw = req.query.limit;
      let limit = 50;
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1 || n > 500) {
          return res.status(400).json({ error: "limit must be between 1 and 500.", code: "INVALID_REQUEST" });
        }
        limit = n;
      }
      const sub = await webhookStore.findById(req.params.id);
      if (!sub) {
        return res.status(404).json({
          error: `No subscription with id ${req.params.id}.`,
          code: "SUBSCRIPTION_NOT_FOUND"
        });
      }
      const status = req.query.status ? String(req.query.status) : undefined;
      const event = req.query.event ? String(req.query.event) : undefined;
      const deliveries = await webhookDeliveryStore.findRecent({
        subscriptionId: sub.id,
        status,
        event,
        limit
      });
      return res.json({ ok: true, deliveries });
    } catch (err) {
      if (err instanceof WebhookDeliveryStoreError) {
        return res.status(webhookErrorStatus(err)).json(webhookErrorBody(err));
      }
      console.error("[webhook] deliveries list failed:", err);
      return res.status(503).json({
        error: "Webhook deliveries fetch failed.",
        code: "STORE_READ_FAILED"
      });
    }
  });

  router.post("/api/admin/webhooks/:id/deliveries/:deliveryId/retry", async (req, res) => {
    if (!webhooksEnabled) {
      return res.status(409).json({
        error: "Webhooks are disabled at the server level (WEBHOOKS_ENABLED=false). Cannot retry deliveries.",
        code: "WEBHOOKS_DISABLED"
      });
    }
    try {
      const sub = await webhookStore.findById(req.params.id);
      if (!sub) {
        return res.status(404).json({
          error: `No subscription with id ${req.params.id}.`,
          code: "SUBSCRIPTION_NOT_FOUND"
        });
      }
      const delivery = await webhookDeliveryStore.findById(req.params.deliveryId);
      if (!delivery || delivery.subscriptionId !== sub.id) {
        return res.status(404).json({
          error: `No delivery with id ${req.params.deliveryId} for this subscription.`,
          code: "DELIVERY_NOT_FOUND"
        });
      }
      if (delivery.status !== "failed") {
        return res.status(409).json({
          error: `Delivery is in ${delivery.status} state and cannot be retried.`,
          code: "INVALID_REQUEST"
        });
      }
      const retried = await withSlot(async () => {
        return webhookService.retryDelivery(delivery.id);
      });
      webhookAudit("delivery.retry", {
        actor: actorFingerprint(req),
        id: sub.id,
        deliveryId: delivery.id
      });
      return res.json({ ok: true, delivery: retried });
    } catch (err) {
      if (err instanceof WebhookStoreError || err instanceof WebhookDeliveryStoreError) {
        return res.status(webhookErrorStatus(err)).json(webhookErrorBody(err));
      }
      console.error("[webhook] retry failed:", err);
      return res.status(503).json({
        error: "Webhook retry failed.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  // ── Push notifications (admin) ──────────────────────────────────────
  // Player-facing endpoints (subscribe/unsubscribe/vapid-public-key)
  // live in routes/notifications.js. These admin endpoints surface
  // counts/timestamps and the broadcast control.
  function notificationAudit(action, fields) {
    try {
      console.log(JSON.stringify({
        event: `[notify] ${action}`,
        ts: new Date().toISOString(),
        ...fields
      }));
    } catch (_err) {
      // best-effort
    }
  }

  if (pushSubscriptionStore && notificationService) {
    router.get("/api/admin/notifications/subscriptions", async (req, res) => {
      try {
        const snap = await pushSubscriptionStore.getSnapshot();
        // Never echo raw endpoints or keys — admin only sees counts +
        // timestamps and a list of opaque endpointHashes for visibility.
        return res.json({
          ok: true,
          count: snap.subscriptions.length,
          lastBroadcastAt: snap.lastBroadcastAt,
          lastDailyFireAt: snap.lastDailyFireAt,
          // Lightweight per-row info to surface stale subscriptions in
          // the admin UI without leaking the endpoint URL.
          rows: snap.subscriptions.map((s) => ({
            endpointHash: s.endpointHash,
            createdAt: s.createdAt,
            lastSuccessAt: s.lastSuccessAt || null,
            lastFailureAt: s.lastFailureAt || null,
            failureStreak: s.failureStreak || 0,
            ua: s.ua || null
          }))
        });
      } catch (err) {
        if (err instanceof PushSubscriptionStoreError) {
          return res.status(503).json({ error: err.message, code: err.code });
        }
        console.error("[notify] subscriptions list failed:", err);
        return res.status(503).json({
          error: "Subscription list failed.",
          code: "STORE_READ_FAILED"
        });
      }
    });

    router.post("/api/admin/notifications/broadcast", async (req, res) => {
      const body = req.body || {};
      const title = String(body.title || "").trim();
      const messageBody = String(body.body || "").trim();
      const url = String(body.url || "").trim();
      const dryRun = body.dryRun === true;

      if (!title || title.length > 80) {
        return res.status(400).json({
          error: "title is required and must be 1–80 characters.",
          code: "INVALID_REQUEST"
        });
      }
      if (!messageBody || messageBody.length > 200) {
        return res.status(400).json({
          error: "body is required and must be 1–200 characters.",
          code: "INVALID_REQUEST"
        });
      }
      if (url && url.length > 256) {
        return res.status(400).json({
          error: "url must be at most 256 characters.",
          code: "INVALID_REQUEST"
        });
      }
      // Require a true root-relative path: must start with `/`, must
      // NOT start with `//` (scheme-relative — `//evil.example/x`
      // navigates off-origin from the click handler), and must not
      // be a bare segment like `play` (`new URL('play', origin)`
      // would resolve relative to the current page rather than the
      // site root, which is also surprising for a stored config).
      if (url && (!url.startsWith("/") || url.startsWith("//"))) {
        return res.status(400).json({
          error: "url must be a root-relative path (e.g. /, /play). Scheme-relative // and bare segments are rejected.",
          code: "INVALID_REQUEST"
        });
      }

      const payload = {
        title,
        body: messageBody,
        url: url || "/",
        tag: "admin-broadcast"
      };
      try {
        const result = await notificationService.broadcast(payload, { dryRun });
        if (!dryRun) {
          await pushSubscriptionStore.stampLastBroadcast(new Date()).catch(() => {});
        }
        notificationAudit(dryRun ? "broadcast.preview" : "broadcast.send", {
          actor: actorFingerprint(req),
          recipients: result.recipients ?? null,
          sent: result.sent ?? null,
          failed: result.failed ?? null,
          gone: result.gone ?? null
        });
        return res.json({ ok: true, dryRun, result });
      } catch (err) {
        console.error("[notify] broadcast failed:", err);
        return res.status(503).json({
          error: "Broadcast failed.",
          code: "BROADCAST_FAILED"
        });
      }
    });
  }

  // ── Challenge mode (admin) ───────────────────────────────────────────
  if (challengeConfigStore && challengeResultsStore && challengeEngine) {
    function challengeAdminError(res, err, context) {
      if (err instanceof ChallengeConfigStoreError || err instanceof ChallengeResultsStoreError) {
        const status = err.code === "INVALID_REQUEST" ? 400
          : err.code === "CHALLENGE_NOT_FOUND" || err.code === "SESSION_NOT_FOUND" ? 404
          : err.code === "CONFIG_LOCKED" || err.code === "DUPLICATE_ID" ? 409
          : 503;
        return res.status(status).json({ error: err.message, code: err.code });
      }
      console.error(`[challenge:admin] ${context} failed:`, err);
      return res.status(503).json({ error: "Challenge admin request failed.", code: "INTERNAL" });
    }

    router.get("/api/admin/challenges", async (req, res) => {
      try {
        const all = await challengeConfigStore.listAll();
        // Single-pass session count by challenge id — the previous
        // .map(c => allSessions.filter(...)) was O(challenges × sessions)
        // and would scale poorly once many sessions accumulated.
        const allSessions = (await challengeResultsStore.getSnapshot()).sessions;
        const countByChallenge = new Map();
        for (const s of allSessions) {
          countByChallenge.set(s.challengeId, (countByChallenge.get(s.challengeId) || 0) + 1);
        }
        const summary = all.map((c) => ({
          ...c,
          sessionCount: countByChallenge.get(c.id) || 0
        }));
        return res.json({
          ok: true,
          challenges: summary,
          enabled: challengeModeEnabled !== false
        });
      } catch (err) {
        return challengeAdminError(res, err, "list");
      }
    });

    function enforceEnvCaps(input) {
      // Operator's deploy-time caps tighten the per-deployment range.
      // Schema/store enforces 30–7200s and 1–50 puzzles as hard caps;
      // these are the operator's softer caps surfaced as a 400.
      if (Number.isInteger(input.timeBudgetSeconds) && Number.isInteger(challengeMaxTimeBudgetSeconds)
        && input.timeBudgetSeconds > challengeMaxTimeBudgetSeconds) {
        throw new ChallengeConfigStoreError(
          "INVALID_REQUEST",
          `timeBudgetSeconds exceeds operator cap of ${challengeMaxTimeBudgetSeconds}.`
        );
      }
      if (Number.isInteger(input.puzzleCount) && Number.isInteger(challengeMaxPuzzles)
        && input.puzzleCount > challengeMaxPuzzles) {
        throw new ChallengeConfigStoreError(
          "INVALID_REQUEST",
          `puzzleCount exceeds operator cap of ${challengeMaxPuzzles}.`
        );
      }
    }

    router.post("/api/admin/challenges", async (req, res) => {
      try {
        const body = req.body || {};
        enforceEnvCaps(body);
        const created = await withSlot(async () => {
          return challengeConfigStore.create(body);
        });
        webhookAudit("challenge.create", {
          actor: actorFingerprint(req),
          id: created.id,
          name: created.name,
          lang: created.lang
        });
        return res.status(201).json({ ok: true, challenge: created });
      } catch (err) {
        return challengeAdminError(res, err, "create");
      }
    });

    router.put("/api/admin/challenges/:id", async (req, res) => {
      try {
        const body = req.body || {};
        enforceEnvCaps(body);
        const sessions = await challengeResultsStore.getSnapshot();
        const hasResults = sessions.sessions.some((s) => s.challengeId === req.params.id);
        const updated = await withSlot(async () => {
          return challengeConfigStore.update(req.params.id, body, { hasResults });
        });
        webhookAudit("challenge.update", {
          actor: actorFingerprint(req),
          id: updated.id
        });
        return res.json({ ok: true, challenge: updated });
      } catch (err) {
        return challengeAdminError(res, err, "update");
      }
    });

    router.delete("/api/admin/challenges/:id", async (req, res) => {
      try {
        const removed = await withSlot(async () => {
          return challengeConfigStore.softDelete(req.params.id);
        });
        webhookAudit("challenge.delete", {
          actor: actorFingerprint(req),
          id: removed.id
        });
        return res.json({ ok: true, challenge: removed });
      } catch (err) {
        return challengeAdminError(res, err, "delete");
      }
    });

    router.get("/api/admin/challenges/:id/leaderboard", async (req, res) => {
      try {
        const challenge = await challengeConfigStore.findById(req.params.id);
        if (!challenge) {
          return res.status(404).json({ error: "Challenge not found.", code: "CHALLENGE_NOT_FOUND" });
        }
        const sessions = await challengeResultsStore.findCompletedForChallenge(challenge.id);
        const rows = challengeEngine.buildLeaderboard({ challenge, sessions });
        return res.json({ ok: true, challenge, rows });
      } catch (err) {
        return challengeAdminError(res, err, "leaderboard");
      }
    });
  }

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
    // Profile is gone from the leaderboard; pull it out of any class roster
    // so class detail/report don't surface a "(missing profile)" row.
    let classCleanupTouched = 0;
    let classCleanupError = null;
    try {
      classCleanupTouched = await classesStore.removeMemberEverywhere(profileId);
    } catch (err) {
      classCleanupError = err;
      console.warn(
        `[admin] Profile ${profileId} deleted from leaderboard but class cleanup failed: ${err?.message || String(err)}`
      );
    }
    const responseBody = {
      ok: true,
      deletedProfileId: profileId,
      classCleanupTouched
    };
    if (classCleanupError) {
      responseBody.partialFailure = {
        message: "Profile deleted from leaderboard, but class cleanup failed. Class rosters may still reference the deleted profile id.",
        error: classCleanupError?.message || String(classCleanupError)
      };
      return res.status(207).json(responseBody);
    }
    return res.json(responseBody);
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

    let mergedProfile;
    try {
      const snapshot = await leaderboardStore.mergeProfiles(sourceId, targetId);
      mergedProfile = snapshot.profiles.find((profile) => profile.id === targetId) || null;
      if (!mergedProfile) {
        throw new Error("Failed to persist merged profile.");
      }
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
    // The source profile is gone; rewrite class memberships so a class that
    // had the source now references the merged target instead. If the target
    // is already a member, the source reference is just dropped.
    let classMembershipsTransferred = [];
    let classCleanupError = null;
    try {
      const result = await classesStore.replaceMemberEverywhere(sourceId, targetId);
      classMembershipsTransferred = result.touchedClassIds;
    } catch (err) {
      classCleanupError = err;
      console.warn(
        `[admin] Profile ${sourceId} merged into ${targetId} but class membership rewrite failed: ${err?.message || String(err)}`
      );
    }
    const responseBody = {
      ok: true,
      mergedProfile,
      deletedProfileId: sourceId,
      classMembershipsTransferred
    };
    if (classCleanupError) {
      responseBody.partialFailure = {
        message: "Profile merge succeeded, but class membership rewrite failed. Some classes may still reference the source profile id.",
        error: classCleanupError?.message || String(classCleanupError)
      };
      return res.status(207).json(responseBody);
    }
    return res.json(responseBody);
  });

  router.get("/api/admin/runtime-config", (req, res) => {
    return res.json(buildRuntimeConfigResponse());
  });

  router.put("/api/admin/runtime-config", async (req, res) => {
    // Atomic claim: wait for the data-mutation lock, then bump the
    // direct-write counter under one synchronous tick so a restore
    // can't race in between our lock-wait and the cap validation +
    // persist. Restore observes the counter and 409s while we hold
    // the slot. The slot is released in the finally below regardless
    // of success/failure.
    const releaseSlot = await claimDirectDataWriteSlot();
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
    } finally {
      releaseSlot();
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

    // Refuse to start (or enqueue) any import while a restore is in
    // flight. The async path below would otherwise persist a job into
    // data/admin-jobs.json during the restore upload window; the
    // restore would then overwrite that file with the archive's
    // contents and the just-enqueued job (plus any staged manual
    // upload) would vanish.
    if (dataMutationLockRef?.value || restoreInProgressRef?.value) {
      return providerAdminError(
        res,
        new StatsApiError(
          409,
          "A backup or restore is currently running; provider imports are paused. Retry once it completes."
        )
      );
    }

    if (!importAsync) {
      if (
        providerImportQueueActiveRef.value
        || providerImportSyncActiveRef.value
      ) {
        return providerAdminError(
          res,
          new StatsApiError(
            409,
            "Another import is currently running. Retry with async=true or wait for completion."
          )
        );
      }

      providerImportSyncActiveRef.value = true;
      let syncResult = null;
      let syncError = null;
      try {
        syncResult = await runProviderImportPipeline({
          sourceType,
          variant,
          commit: commitInput || null,
          expectedChecksums,
          filterMode,
          manualFiles: req.body?.manualFiles
        });
        return res.json({
          ...syncResult,
          providers: buildProviderStatusRows()
        });
      } catch (err) {
        syncError = err;
        return providerAdminError(res, mapProviderPipelineError(err));
      } finally {
        providerImportSyncActiveRef.value = false;
        // Fire-and-forget emit so the response isn't held up by webhook
        // delivery. Errors are logged but never bubble to the client.
        if (webhookService) {
          if (syncResult) {
            webhookService
              .emit("provider.import.completed", {
                jobId: null,
                variant: syncResult.variant,
                commit: syncResult.commit,
                sourceType: syncResult.sourceType,
                filterMode: syncResult.filterMode,
                counts: syncResult.counts,
                artifacts: syncResult.artifacts
              })
              .catch((emitErr) => {
                console.error("[webhook] emit failed for sync import:", emitErr);
              });
          } else if (syncError) {
            webhookService
              .emit("provider.import.failed", {
                jobId: null,
                variant,
                sourceType,
                error: { message: syncError?.message || String(syncError) }
              })
              .catch((emitErr) => {
                console.error("[webhook] emit failed for sync import:", emitErr);
              });
          }
        }
        startProviderImportQueueIfNeeded().catch((queueErr) => {
          console.error("Provider import queue processing failed.", queueErr);
        });
      }
    }

    // Async path: enqueue job. Claim the enqueue slot synchronously
    // so a restore that fires during the staging+enqueue window can't
    // race past us — the restore busy check observes
    // providerImportEnqueueActiveRef and will 409. The flag clears in
    // the finally below regardless of success/failure.
    if (providerImportEnqueueActiveRef) {
      providerImportEnqueueActiveRef.value = true;
    }
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
      if (providerImportEnqueueActiveRef) {
        providerImportEnqueueActiveRef.value = false;
      }
      return providerAdminError(res, err instanceof StatsApiError ? err : mapProviderPipelineError(err));
    }
    // Job is durably enqueued; release the enqueue guard. The queue
    // starter below claims providerImportQueueActiveRef before
    // processing the job.
    if (providerImportEnqueueActiveRef) {
      providerImportEnqueueActiveRef.value = false;
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

  router.post("/api/admin/providers/:variant/enable", async (req, res) => {
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

    // Claim the direct-write slot before persisting the toggle. The
    // upsert writes data/languages.json, which a restore will swap
    // out from underneath any unbarrier-ed write. Without this, an
    // enable that lands during a restore upload window would 200,
    // then be silently overwritten by the archive's languages.json.
    const releaseSlot = await claimDirectDataWriteSlot();
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
    } finally {
      releaseSlot();
    }
  });

  router.post("/api/admin/providers/:variant/disable", async (req, res) => {
    let variant;
    try {
      variant = parseProviderVariant(req.params.variant);
    } catch (err) {
      return providerAdminError(res, err);
    }

    // Same direct-write-slot rationale as /enable above: the
    // setLanguageEnabledSync call writes data/languages.json and must
    // be serialised against a concurrent restore.
    const releaseSlot = await claimDirectDataWriteSlot();
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
    } finally {
      releaseSlot();
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
          wins: 0,
          playedCount: 0,
          winRate: null,
          lastPlayedAt: null,
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

    let carveOutIds = [];
    let removedProfileIds = [];
    let leaderboardCleanupError = null;
    try {
      if (deleteProfilesFlag) {
        // Atomic in classes-store: drops the class, computes which member
        // IDs are NOT in any other non-archived class, and removes those
        // from every (archived) class that still references them. The
        // classes-side state is consistent before we touch the leaderboard.
        const result = await classesStore.deleteClassWithCarveOut(classId);
        carveOutIds = result.carveOutIds;
      } else {
        // Just delete the class without touching profiles.
        await classesStore.deleteClass(classId);
      }
    } catch (err) {
      return handleClassesStoreError(res, err, "Class delete failed.");
    }

    let eligibleForCleanup = [];
    if (deleteProfilesFlag && carveOutIds.length > 0) {
      // Class is already deleted at this point. If the leaderboard mutate
      // fails, returning an error would mislead the client into retrying a
      // delete that's already happened (404 on retry). Instead capture the
      // failure as a partial-success signal so callers can reconcile.
      // Track tentative removals separately so we don't expose them to the
      // caller until persist completes — a mutator that runs but fails to
      // persist would otherwise leak unpersisted IDs into deletedProfileIds.
      //
      // Cross-store race: between deleteClassWithCarveOut returning and the
      // leaderboard mutate running, a concurrent bulk-add could have added
      // one of these carve-out IDs to a different class. Re-read the
      // classes-store snapshot and skip IDs that are now class members so
      // we don't strip a profile that another class legitimately needs.
      try {
        const referencedNow = new Set();
        try {
          const classesSnapshot = await classesStore.getSnapshot();
          for (const entry of classesSnapshot.classes) {
            for (const memberId of entry.memberProfileIds) {
              referencedNow.add(memberId);
            }
          }
        } catch (snapshotErr) {
          console.warn(
            `[admin] Carve-out could not read classes snapshot; continuing without race-window filter: ${snapshotErr?.message || String(snapshotErr)}`
          );
        }
        eligibleForCleanup = carveOutIds.filter((id) => !referencedNow.has(id));
        const tentativeRemoved = [];
        await leaderboardStore.mutate((draft) => {
          for (const memberId of eligibleForCleanup) {
            const idx = draft.profiles.findIndex((profile) => profile.id === memberId);
            if (idx !== -1) {
              draft.profiles.splice(idx, 1);
              if (
                draft.resultsByProfile
                && Object.prototype.hasOwnProperty.call(draft.resultsByProfile, memberId)
              ) {
                delete draft.resultsByProfile[memberId];
              }
              tentativeRemoved.push(memberId);
            }
          }
        });
        removedProfileIds = tentativeRemoved;
      } catch (err) {
        leaderboardCleanupError = err;
        console.warn(
          `[admin] Class ${classId} deleted but profile carve-out failed: ${err?.message || String(err)}`
        );
      }
    }

    const responseBody = {
      ok: true,
      deletedClassId: classId,
      deletedProfileIds: removedProfileIds
    };
    if (leaderboardCleanupError) {
      responseBody.partialFailure = true;
      // Report only IDs we actually attempted to clean up (filtered for
      // cross-store race) and didn't successfully remove. IDs that were
      // intentionally skipped (now-referenced by another class) are not
      // pending — they belong to that other class now.
      const removedSet = new Set(removedProfileIds);
      responseBody.pendingProfileIds = eligibleForCleanup.filter((id) => !removedSet.has(id));
      responseBody.message = "Class deleted, but profile cleanup failed. Pending profile IDs are listed and may need manual reconciliation.";
    }
    return res.json(responseBody);
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
      // Treat the size-limit breach the same as the explicit-array path so
      // clients can reliably distinguish "too large" (413) from genuine
      // CSV syntax errors (400).
      const sizeBreach = parseErrors.some((entry) =>
        typeof entry?.message === "string" && entry.message.includes("exceeded")
      );
      if (sizeBreach) {
        return res.status(413).json({
          error: `Bulk input exceeded ${SUPPORTED_BULK_LIMIT} names per request.`
        });
      }
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

    // Pre-validate the per-class member cap. The check counts only names that
    // would be NET-NEW members of this class — names that resolve to a
    // profile already in the class (or names not yet in the leaderboard but
    // assumed-new under fail-closed semantics) — so an idempotent re-upload
    // of an at-cap roster doesn't trip the cap.
    let leaderboardSnapshotForPrecheck;
    try {
      leaderboardSnapshotForPrecheck = await leaderboardStore.getSnapshot();
    } catch (err) {
      return handleClassesStoreError(res, err, "Leaderboard snapshot for cap pre-check failed.");
    }
    const existingProfileByLowerName = new Map();
    for (const profile of leaderboardSnapshotForPrecheck.profiles) {
      existingProfileByLowerName.set(profile.name.toLowerCase(), profile.id);
    }
    const targetMemberSet = new Set(target.memberProfileIds);
    let projectedNetNew = 0;
    for (const name of normalizedNames) {
      const existingId = existingProfileByLowerName.get(name.toLowerCase());
      if (!existingId || !targetMemberSet.has(existingId)) {
        projectedNetNew += 1;
      }
    }
    if (target.memberProfileIds.length + projectedNetNew > classesStore.maxMembersPerClass) {
      return res.status(409).json({
        error: `Class is at the per-class member cap of ${classesStore.maxMembersPerClass}.`
      });
    }

    // Host-cap pre-check. Count names that would create truly new profiles
    // (not in the leaderboard) and reject 409 if accepting the request
    // would push the host past LEADERBOARD_MAX_PROFILES. Without this, the
    // mutate path's normalizer would silently prune older profiles —
    // including profiles owned by other classes — to make room.
    let projectedNetNewProfiles = 0;
    for (const name of normalizedNames) {
      if (!existingProfileByLowerName.has(name.toLowerCase())) {
        projectedNetNewProfiles += 1;
      }
    }
    const hostCap = leaderboardStore.maxProfiles;
    if (
      Number.isInteger(hostCap)
      && hostCap > 0
      && leaderboardSnapshotForPrecheck.profiles.length + projectedNetNewProfiles > hostCap
    ) {
      return res.status(409).json({
        error: `Adding these names would exceed the host profile cap of ${hostCap}. Free space first or split the upload.`
      });
    }

    // Resolve each name to an existing profile (case-insensitive match) or
    // create a new profile inside a single mutate so we never half-write.
    // The pre-check above bounds growth, but we re-validate inside the
    // mutate to defend against concurrent bulk-adds: two requests that
    // each pass the pre-check could still overflow when serialized. The
    // throw aborts the mutate and rolls back the draft, so no profiles
    // are persisted.
    const resolvedProfileIds = [];
    const reusedProfileIds = [];
    const createdProfileIds = [];
    try {
      await leaderboardStore.mutate((draft) => {
        const nowIso = new Date().toISOString();
        const existingByLowerName = new Map(
          draft.profiles.map((profile) => [profile.name.toLowerCase(), profile])
        );
        for (const name of normalizedNames) {
          const key = name.toLowerCase();
          const existing = existingByLowerName.get(key);
          if (existing) {
            resolvedProfileIds.push(existing.id);
            reusedProfileIds.push(existing.id);
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
          createdProfileIds.push(created.id);
        }
        if (Number.isInteger(hostCap) && hostCap > 0 && draft.profiles.length > hostCap) {
          throw new ClassesStoreError(
            "HOST_CAP_EXCEEDED",
            `Adding these names would exceed the host profile cap of ${hostCap}. Free space first or split the upload.`
          );
        }
      });
    } catch (err) {
      if (err && err.code === "HOST_CAP_EXCEEDED") {
        return res.status(409).json({ error: err.message });
      }
      return handleClassesStoreError(res, err, "Bulk profile resolution failed.");
    }

    // Cross-store race: between resolving resolvedProfileIds in the
    // leaderboard mutate above and calling addMembers below, a concurrent
    // admin DELETE /api/admin/stats/profile/:id (or a profile-merge) can
    // remove one of those IDs from the leaderboard. Re-read a fresh
    // leaderboard snapshot and filter resolvedProfileIds so we don't
    // persist a class member id that no longer points at a real profile.
    let membersToAdd = resolvedProfileIds;
    try {
      const recheck = await leaderboardStore.getSnapshot();
      const liveIds = new Set(recheck.profiles.map((profile) => profile.id));
      membersToAdd = resolvedProfileIds.filter((id) => liveIds.has(id));
    } catch (recheckErr) {
      console.warn(
        `[admin] Bulk add could not revalidate profile IDs against the leaderboard; proceeding with the resolved set: ${recheckErr?.message || String(recheckErr)}`
      );
    }
    const droppedDuringRecheck = resolvedProfileIds.filter(
      (id) => !membersToAdd.includes(id)
    );

    let addOutcome;
    try {
      addOutcome = await classesStore.addMembers(classId, membersToAdd);
    } catch (err) {
      // Race window: between the pre-check and addMembers, another admin
      // could have archived the class or filled the per-class cap. Roll back
      // the profiles we just created so a failed bulk import doesn't pollute
      // the leaderboard with orphaned profiles. Reused profiles existed
      // before this request and stay.
      //
      // Cross-store race: a concurrent bulk-add could have looked up one of
      // our newly created profiles by name and added it to a different
      // class while addMembers was failing. Filter createdProfileIds against
      // a fresh classes-store snapshot so we don't delete profiles that are
      // now legitimately in use.
      if (createdProfileIds.length > 0) {
        try {
          const referencedNow = new Set();
          try {
            const classesSnapshot = await classesStore.getSnapshot();
            for (const entry of classesSnapshot.classes) {
              for (const memberId of entry.memberProfileIds) {
                referencedNow.add(memberId);
              }
            }
          } catch (snapshotErr) {
            console.warn(
              `[admin] Bulk add rollback could not read classes snapshot; continuing without race-window filter: ${snapshotErr?.message || String(snapshotErr)}`
            );
          }
          const safeToDelete = createdProfileIds.filter((id) => !referencedNow.has(id));
          if (safeToDelete.length > 0) {
            const safeSet = new Set(safeToDelete);
            await leaderboardStore.mutate((draft) => {
              draft.profiles = draft.profiles.filter((profile) => !safeSet.has(profile.id));
              if (draft.resultsByProfile && typeof draft.resultsByProfile === "object") {
                for (const id of safeSet) {
                  if (Object.prototype.hasOwnProperty.call(draft.resultsByProfile, id)) {
                    delete draft.resultsByProfile[id];
                  }
                }
              }
            });
          }
        } catch (rollbackErr) {
          console.warn(
            `[admin] Bulk add failed and rollback of new profiles also failed: ${rollbackErr?.message || String(rollbackErr)}`
          );
        }
      }
      return handleClassesStoreError(res, err, "Bulk class add failed.");
    }

    const droppedSet = new Set(droppedDuringRecheck);
    const responseBody = {
      ok: true,
      addedToClass: addOutcome.added,
      createdProfileIds: createdProfileIds.filter((id) => !droppedSet.has(id)),
      reusedProfileIds: reusedProfileIds.filter((id) => !droppedSet.has(id)),
      classMemberCount: addOutcome.class.memberProfileIds.length
    };
    if (droppedDuringRecheck.length > 0) {
      responseBody.droppedDueToConcurrentDelete = droppedDuringRecheck;
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
    // Cap-check the span BEFORE materializing the date array, so a
    // syntactically valid but huge range (e.g. from=0100-01-01&to=9999-12-31)
    // doesn't allocate millions of strings just to return a 400.
    const fromMs = Date.UTC(
      Number(fromDate.slice(0, 4)),
      Number(fromDate.slice(5, 7)) - 1,
      Number(fromDate.slice(8, 10))
    );
    const toMs = Date.UTC(
      Number(toDate.slice(0, 4)),
      Number(toDate.slice(5, 7)) - 1,
      Number(toDate.slice(8, 10))
    );
    const projectedDays = Math.floor((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
    if (projectedDays > REPORT_MAX_DAYS) {
      return res.status(400).json({
        error: `Date range exceeds the ${REPORT_MAX_DAYS}-day cap.`
      });
    }
    const dates = eachDateInRange(fromDate, toDate);

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
