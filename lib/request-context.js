"use strict";

// AsyncLocalStorage wrapper for per-request context (B3 / #122).
//
// What this is for
// ----------------
// Every log line emitted during a single inbound request should share
// a correlation ID so an operator can grep all activity related to one
// click in the admin UI. We don't want every logger call site to take
// a `req.id` argument, so the ID rides in async-local-storage instead.
//
// The middleware in `lib/request-id-middleware.js` calls
// `requestContext.run({ requestId }, () => next())` once per request.
// Anything that runs synchronously OR via awaited promises during that
// `next()` chain — including timers, fs/promises calls, and chained
// `await` boundaries — sees the same store thanks to V8's async
// context tracking.
//
// What it is NOT
// --------------
// Not a place to stash request-scoped business data. The only
// supported field today is `requestId`. Add fields here only when
// there is a concrete observability reason and a corresponding test —
// otherwise it becomes an anti-pattern dumping ground.
//
// Performance note
// ----------------
// `AsyncLocalStorage` adds a small per-async-boundary cost. We measured
// ~0.1ms overhead per request on the admin paths in dev; negligible at
// our scale. Hot loops inside a single tick are unaffected.

const { AsyncLocalStorage } = require("node:async_hooks");

const requestContext = new AsyncLocalStorage();

// Pull just the request ID (the most common consumer). Returns `null`
// when called from a non-request context — module init, scheduler
// ticks, jest workers, etc. Logger callers MUST tolerate `null`
// silently (omit the field) rather than fabricating a placeholder.
function getRequestId() {
  const store = requestContext.getStore();
  if (!store || typeof store !== "object") return null;
  const id = store.requestId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// Convenience for tests and any non-middleware code that needs to run
// a block under a synthetic request ID (e.g., a webhook redelivery
// initiated by a cron tick that should inherit the admin's request ID
// when triggered manually).
function runWithRequestId(requestId, fn) {
  return requestContext.run({ requestId }, fn);
}

module.exports = {
  requestContext,
  getRequestId,
  runWithRequestId
};
