"use strict";

// Minimal structured logger for B2 / #121. JSON-line output, level
// filtering via LOG_LEVEL env, per-call field bag. No external
// dependencies — all output goes to process.stdout (info/debug) or
// process.stderr (warn/error) so operators redirect with shell as
// needed.
//
// Usage:
//
//   const { logger } = require("./lib/logger");
//   logger.info("schedule.commit", { storeId, durationMs });
//   logger.warn("provider.disabled", { variant, reason });
//   logger.error("backup.restore_failed", { stagingDir, error: err.message });
//
// LOG_LEVEL env values (most to least verbose):
//
//   "debug" — everything
//   "info"  — info, warn, error  (DEFAULT)
//   "warn"  — warn, error
//   "error" — error only
//   "silent" — nothing (used in jest setup so tests don't dump
//             logs)
//
// Each log call serializes to one JSON line:
//
//   { ts, level, msg, ...fields }
//
//   - ts:     ISO-8601 UTC timestamp.
//   - level:  one of debug | info | warn | error.
//   - msg:    the first positional argument.
//   - fields: shallow-merged from the optional second positional
//             argument. Field values are JSON-stringified; circular
//             refs and Errors are sanitized.
//
// Library code accepts `options.logger` in constructors so tests can
// inject a no-op or a buffer.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const LEVEL_LABELS = ["debug", "info", "warn", "error"];

// AsyncLocalStorage-backed request ID (B3 / #122). Pulled lazily so
// this module stays free of side effects at load time, and so the
// request-context module is allowed to import logger first without a
// circular-require hazard. `null` when called outside a request (jest
// workers, scheduler ticks, bootstrap) — in that case we just omit
// the `requestId` field on the record.
//
// Error handling: only MODULE_NOT_FOUND on the request-context path
// is treated as a benign no-op (covers fresh test sandboxes that
// haven't materialized the file yet, plus the unusual case of this
// logger being copied into a project without the request-context
// sibling). Any OTHER error — syntax error in request-context.js,
// runtime error from its top-level require chain — is rethrown so
// observability regressions get a loud signal at boot rather than
// silently disabling the requestId field. Copilot caught the
// over-broad catch on PR #150.
let getRequestIdFromContext;
function loadRequestIdGetter() {
  if (getRequestIdFromContext !== undefined) return getRequestIdFromContext;
  try {
    ({ getRequestId: getRequestIdFromContext } = require("./request-context"));
  } catch (err) {
    if (err && err.code === "MODULE_NOT_FOUND" && /request-context/.test(err.message || "")) {
      getRequestIdFromContext = null;
      return getRequestIdFromContext;
    }
    throw err;
  }
  return getRequestIdFromContext;
}

function resolveLevel(raw) {
  const v = String(raw || "").toLowerCase().trim();
  if (v in LEVELS) return LEVELS[v];
  return LEVELS.info;
}

function sanitizeFieldValue(value, visited) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "number" || type === "boolean" || type === "string") return value;
  if (type === "bigint") return String(value);
  if (type === "function" || type === "symbol") return undefined;
  if (value instanceof Error) {
    // Carry the message and stack but not the entire error object —
    // unknown error subclasses (e.g., WebhookSendError with cycles)
    // can break JSON.stringify if dumped raw.
    return { message: value.message, name: value.name, stack: value.stack };
  }
  // Cycle detection. Lazily allocate the WeakSet on the FIRST nested
  // object/array so the common non-cyclic path doesn't pay for it.
  // Caught in #149 (Codex P2 + CR Major) — without this guard,
  // logging an object with `obj.self = obj` would stack-overflow
  // here before JSON.stringify's fallback could handle it.
  if (Array.isArray(value) || type === "object") {
    const seen = visited || new WeakSet();
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeFieldValue(item, seen));
    }
    // Null-prototype container so `key === "__proto__"` lands as an
    // own property rather than chancing prototype-pollution semantics
    // — satisfies `npm run proto:check` (A2 / #115).
    const out = Object.create(null);
    for (const key of Object.keys(value)) {
      const sanitized = sanitizeFieldValue(value[key], seen);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }
  return undefined;
}

function emit(level, threshold, msg, fields, writer) {
  if (LEVELS[level] < threshold) return;
  // Null-prototype record so caller-supplied `__proto__`/etc. keys
  // land as own properties rather than chancing prototype-pollution
  // semantics (A2 / #115). JSON.stringify still walks own props
  // identically, so serialization is unaffected.
  const record = Object.assign(Object.create(null), {
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === "string" ? msg : String(msg)
  });
  // Auto-attach the in-flight request ID from ALS so every log line
  // emitted during a request shares the same `requestId` field (B3 /
  // #122). Caller can still override via the `fields` bag if they
  // need to attribute a log line to a different request (e.g., a
  // background job logging the request ID that scheduled it).
  const getter = loadRequestIdGetter();
  if (getter) {
    const ambientId = getter();
    if (ambientId) record.requestId = ambientId;
  }
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    // Thread one visited-set through the whole field-bag iteration
    // so a cycle through the outer `fields` object is caught too
    // (Codex P2 + CR Major on PR #149). The set starts with `fields`
    // itself so a self-reference at the top level becomes
    // "[circular]" instead of being walked again.
    const visited = new WeakSet();
    visited.add(fields);
    for (const key of Object.keys(fields)) {
      // Never let a caller stomp our reserved fields.
      if (key === "ts" || key === "level" || key === "msg") continue;
      const sanitized = sanitizeFieldValue(fields[key], visited);
      if (sanitized !== undefined) record[key] = sanitized;
    }
  }
  let line;
  try {
    line = JSON.stringify(record) + "\n";
  } catch (_err) {
    // Last-resort fallback if a field has hostile shape that
    // survived sanitization — drop the field bag.
    line = JSON.stringify({
      ts: record.ts,
      level: record.level,
      msg: record.msg,
      serializeError: true
    }) + "\n";
  }
  writer(line);
}

// Normalize variadic args into (msg, fields). Supports two shapes:
//   logger.warn("scheduler.failed", { storeId, err })   // structured
//   logger.warn("scheduler.failed:", err, extra)        // console-style
//
// Rationale: the migration sweep from `console.*` swaps the callee
// only; existing call sites that pass an Error or extra strings as
// trailing positional arguments still work, with the Error captured
// in `record.error` and stringy extras concatenated into `msg`.
function normalizeArgs(args) {
  if (args.length === 0) return [undefined, undefined];
  if (args.length === 1) {
    const a = args[0];
    if (a instanceof Error) return [a.message, { error: a }];
    return [a, undefined];
  }
  // Two args, second is a plain object (not Error, not Array): the
  // canonical structured-fields shape. Pass through unchanged.
  if (
    args.length === 2 &&
    args[1] !== null &&
    typeof args[1] === "object" &&
    !(args[1] instanceof Error) &&
    !Array.isArray(args[1])
  ) {
    return [args[0], args[1]];
  }
  // Console-style: multiple args, possibly with Errors mixed in.
  // Stringify each arg into msgParts; collect Errors into a single
  // `error` field (or `errors` array if multiple).
  const msgParts = [];
  const errors = [];
  for (const a of args) {
    if (a instanceof Error) errors.push(a);
    else if (typeof a === "string") msgParts.push(a);
    else {
      try {
        msgParts.push(JSON.stringify(a));
      } catch (_e) {
        msgParts.push(String(a));
      }
    }
  }
  let fields;
  if (errors.length === 1) fields = { error: errors[0] };
  else if (errors.length > 1) fields = { errors };
  return [msgParts.join(" "), fields];
}

function createLogger(options = {}) {
  const threshold = resolveLevel(options.level || process.env.LOG_LEVEL);
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const writeStdout = (line) => stdout.write(line);
  const writeStderr = (line) => stderr.write(line);
  const info = (...args) => {
    const [msg, fields] = normalizeArgs(args);
    emit("info", threshold, msg, fields, writeStdout);
  };
  return {
    debug: (...args) => {
      const [msg, fields] = normalizeArgs(args);
      emit("debug", threshold, msg, fields, writeStdout);
    },
    info,
    // `log` alias of `info` — preserves backward compatibility with
    // callers that were previously passed `console` (which has
    // `.log` but not `.info` semantics). Lets code like
    // `this.logger.log?.(...)` continue to fire after the structured
    // logger replaces the default. Copilot caught this on PR #149.
    log: info,
    warn: (...args) => {
      const [msg, fields] = normalizeArgs(args);
      emit("warn", threshold, msg, fields, writeStderr);
    },
    error: (...args) => {
      const [msg, fields] = normalizeArgs(args);
      emit("error", threshold, msg, fields, writeStderr);
    }
  };
}

// No-op logger for tests that don't want to inspect output. Methods
// are present so injecting this anywhere expecting a logger works.
function createNoopLogger() {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    log: noop,
    warn: noop,
    error: noop
  };
}

// Default singleton — used by anything that doesn't accept an
// injected logger. Library code SHOULD accept `options.logger` and
// fall through to this default when none is provided, so tests can
// inject a noop logger.
const logger = createLogger();

module.exports = {
  logger,
  createLogger,
  createNoopLogger,
  // Exposed for tests / introspection.
  LEVELS,
  LEVEL_LABELS,
  resolveLevel,
  sanitizeFieldValue
};
