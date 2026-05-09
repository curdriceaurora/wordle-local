"use strict";

const express = require("express");

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
    appConfigStore,
    PushSubscriptionStoreError
  } = deps;

  if (!pushSubscriptionStore) {
    throw new TypeError("createNotificationsRouter: pushSubscriptionStore dep is required.");
  }
  if (!appConfigStore) {
    throw new TypeError("createNotificationsRouter: appConfigStore dep is required.");
  }

  const router = express.Router();

  // Public endpoint — never returns the private key. The client uses
  // this to subscribe via PushManager.subscribe({applicationServerKey}).
  router.get("/api/notifications/vapid-public-key", (req, res) => {
    const keys = appConfigStore.getPushKeysSync();
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
        const status = err.code === "INVALID_REQUEST" ? 400 : 503;
        return res.status(status).json({ error: err.message, code: err.code });
      }
      console.error("[notify] subscribe failed:", err);
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
        const status = err.code === "INVALID_REQUEST" ? 400 : 503;
        return res.status(status).json({ error: err.message, code: err.code });
      }
      console.error("[notify] unsubscribe failed:", err);
      return res.status(503).json({
        error: "Unsubscribe failed. Try again later.",
        code: "STORE_WRITE_FAILED"
      });
    }
  });

  return router;
}

module.exports = createNotificationsRouter;
