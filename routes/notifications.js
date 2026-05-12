"use strict";

const express = require("express");
const { logger } = require("../lib/logger");

/**
 * Player-facing notification endpoints.
 * - GET    /api/notifications/vapid-public-key
 * - POST   /api/notifications/subscribe
 * - DELETE /api/notifications/subscribe/:endpointHash
 *
 * Admin endpoints (broadcast, count, broadcast preview) live in
 * routes/admin.js because they require admin auth.
 */
function createNotificationsRouter(deps) {
  const {
    pushSubscriptionStore,
    vapidStore,
    PushSubscriptionStoreError
  } = deps;

  if (!pushSubscriptionStore) {
    throw new TypeError("createNotificationsRouter: pushSubscriptionStore dep is required.");
  }
  if (!vapidStore) {
    throw new TypeError("createNotificationsRouter: vapidStore dep is required.");
  }

  const router = express.Router();

  // Public endpoint — never returns the private key. The client uses
  // this to subscribe via PushManager.subscribe({applicationServerKey}).
  router.get("/api/notifications/vapid-public-key", (req, res) => {
    const keys = vapidStore.getKeysSync();
    if (!keys || !keys.publicKey) {
      return res.status(503).json({
        error: "VAPID keys not provisioned yet. Try again after server boot completes.",
        code: "VAPID_MISSING"
      });
    }
    return res.json({ publicKey: keys.publicKey });
  });

  router.post("/api/notifications/subscribe", async (req, res) => {
    try {
      const body = req.body || {};
      const ua = typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"]
        : undefined;
      const sub = await pushSubscriptionStore.upsert({
        endpoint: body.endpoint,
        keys: body.keys,
        ua
      });
      return res.status(201).json({
        ok: true,
        endpointHash: sub.endpointHash
      });
    } catch (err) {
      if (err instanceof PushSubscriptionStoreError) {
        if (err.code === "INVALID_REQUEST") {
          // INVALID_REQUEST messages are author-curated and safe — they
          // describe the offending field shape, not server-side state.
          return res.status(400).json({ error: err.message, code: err.code });
        }
        // STORE_READ_FAILED / STORE_WRITE_FAILED / STORE_PARSE_FAILED
        // messages may include the absolute store path on disk
        // (push-subscription-store wraps fs errors with a "Failed to
        // read/persist subscriptions store at <path>." message). Mask
        // those for the public endpoint and log the raw error
        // server-side. The error code is generic enough to keep.
        logger.error(`[notify] subscribe ${err.code}:`, err);
        return res.status(503).json({
          error: "Subscription failed. Try again later.",
          code: err.code
        });
      }
      logger.error("[notify] subscribe failed:", err);
      return res.status(503).json({
        error: "Subscription failed. Try again later.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  router.delete("/api/notifications/subscribe/:endpointHash", async (req, res) => {
    try {
      await pushSubscriptionStore.removeByHash(req.params.endpointHash);
      return res.status(204).send();
    } catch (err) {
      if (err instanceof PushSubscriptionStoreError) {
        if (err.code === "INVALID_REQUEST") {
          return res.status(400).json({ error: err.message, code: err.code });
        }
        // Same masking as subscribe — STORE_* messages carry the
        // store filepath and shouldn't reach unauthenticated callers.
        logger.error(`[notify] unsubscribe ${err.code}:`, err);
        return res.status(503).json({
          error: "Unsubscribe failed. Try again later.",
          code: err.code
        });
      }
      logger.error("[notify] unsubscribe failed:", err);
      return res.status(503).json({
        error: "Unsubscribe failed. Try again later.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  return router;
}

module.exports = createNotificationsRouter;
