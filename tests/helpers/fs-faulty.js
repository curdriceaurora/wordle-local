"use strict";

// Fault-injection harness for `node:fs/promises` and sync `node:fs`
// (#129 — Epic C: Test Coverage & Fault Injection).
//
// The stores in `lib/` import `fs`/`fs/promises` directly and don't
// accept an injectable fs option. To test their behavior under
// filesystem failures (ENOSPC, EACCES, partial reads, slow disk)
// without refactoring every store, this helper monkey-patches the
// module-level methods on the cached node:fs and node:fs/promises
// exports — replacing each target fn with a closure that consults
// the fault config, then delegating to the saved original. The
// patches live for the duration of one scenario and are torn down
// by the returned `restore()`. (Originally drafted as "jest spies"
// but we use direct assignment for simpler restore semantics —
// Copilot caught the doc-vs-code mismatch on PR #135.)
//
// Usage:
//   const fsp = require("node:fs/promises");
//   const { installFaultyFs } = require("./helpers/fs-faulty");
//
//   const fault = installFaultyFs({
//     writeFile: { failOnce: { code: "ENOSPC", message: "disk full" } }
//   });
//   try {
//     await expect(store.addEntry(...)).rejects.toThrow(/disk full/);
//   } finally {
//     fault.restore();
//   }
//
// Supported faults per method (writeFile, rename, readFile, mkdir, rm):
//   - `failOnce: error` — first call throws `error`; subsequent calls
//     pass through to the real fsp.
//   - `failAll: error` — every call throws `error`. Useful for "disk
//     is permanently down" scenarios.
//   - `delay: ms` — every call delays by ms before delegating. Useful
//     for slow-disk timing tests.
//   - `failIfPath: { match: RegExp, error: Error }` — fail only when
//     the first argument matches `match`. Useful for "this one file
//     is unreadable" without affecting unrelated I/O.
//
// Each fault config can include any subset of these modes. The
// helper preserves the natural Node error shape (.code, .errno,
// .syscall) when the caller supplies a config object with a `code`
// field — the spy synthesizes a NodeError-like object so production
// `err.code === "ENOSPC"` branches fire.
//
// Restore semantics: `restore()` always restores to the real fsp,
// regardless of which faults fired. Call it from a try/finally so
// a failing assertion doesn't leak spies into the next test.

const fsModule = require("node:fs");
const fsp = require("node:fs/promises");

// Methods we support faults on. Add more as tests need them — every
// store under test today reads/writes via these.
//
// We expose the same set against BOTH `node:fs/promises` and the sync
// `node:fs` namespace. Stores like `admin-jobs-store` use `fs.writeFileSync`
// + `fs.renameSync` directly; without sync coverage their fault-
// injection tests would silently pass even with the harness installed.
const SUPPORTED_METHODS = ["writeFile", "rename", "readFile", "mkdir", "rm"];
const SUPPORTED_SYNC_METHODS = [
  "writeFileSync",
  "renameSync",
  "readFileSync",
  "mkdirSync",
  "rmSync"
];

function makeError(spec) {
  if (spec instanceof Error) return spec;
  const err = new Error(spec.message || `Synthetic ${spec.code || "I/O"} error`);
  if (spec.code) err.code = spec.code;
  if (spec.errno !== undefined) err.errno = spec.errno;
  if (spec.syscall) err.syscall = spec.syscall;
  if (spec.path) err.path = spec.path;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `RegExp.prototype.test` advances `lastIndex` when the regex carries
// the `g` or `y` flag — calling it twice on the same regex with the
// same input can yield different answers (Copilot caught the
// statefulness on PR #135). Reset lastIndex defensively before each
// check so config regexes with sticky/global flags don't make the
// harness behave inconsistently across calls.
function matchesPath(regex, target) {
  if (regex.global || regex.sticky) {
    regex.lastIndex = 0;
  }
  return regex.test(target);
}

function buildAsyncSpyImpl(originalFn, owner, faultConfig) {
  // Closure-local state so each install gets its own "failOnce" gate.
  let onceFired = false;
  return async function spyImpl(...args) {
    if (typeof faultConfig.delay === "number" && faultConfig.delay > 0) {
      await sleep(faultConfig.delay);
    }
    if (faultConfig.failIfPath) {
      const target = String(args[0] || "");
      if (matchesPath(faultConfig.failIfPath.match, target)) {
        throw makeError(faultConfig.failIfPath.error);
      }
    }
    if (faultConfig.failOnce && !onceFired) {
      onceFired = true;
      throw makeError(faultConfig.failOnce);
    }
    if (faultConfig.failAll) {
      throw makeError(faultConfig.failAll);
    }
    return originalFn.apply(owner, args);
  };
}

function buildSyncSpyImpl(originalFn, owner, faultConfig) {
  // Sync variant — no `delay` support (would block the event loop)
  // and no async-await. Same failOnce/failAll/failIfPath semantics.
  let onceFired = false;
  return function spyImpl(...args) {
    if (faultConfig.failIfPath) {
      const target = String(args[0] || "");
      if (matchesPath(faultConfig.failIfPath.match, target)) {
        throw makeError(faultConfig.failIfPath.error);
      }
    }
    if (faultConfig.failOnce && !onceFired) {
      onceFired = true;
      throw makeError(faultConfig.failOnce);
    }
    if (faultConfig.failAll) {
      throw makeError(faultConfig.failAll);
    }
    return originalFn.apply(owner, args);
  };
}

function installFaultyFs(faults) {
  // Reject obviously bad input loudly rather than letting a typo'd
  // call (`installFaultyFs()` with no args, or with `null`) fail
  // deep inside the property loop with a confusing TypeError —
  // Copilot caught this on PR #135.
  if (faults === null || typeof faults !== "object") {
    throw new TypeError(
      `[fs-faulty] installFaultyFs(faults): expected an object, got ${
        faults === null ? "null" : typeof faults
      }`
    );
  }
  // Warn on unknown keys so a typo like `writefile` (lowercase 'f')
  // doesn't silently no-op — CodeRabbit caught this on PR #135.
  const allKnown = new Set([...SUPPORTED_METHODS, ...SUPPORTED_SYNC_METHODS]);
  for (const key of Object.keys(faults)) {
    if (!allKnown.has(key)) {
      throw new Error(
        `[fs-faulty] unknown method '${key}' in fault config. Supported: ${
          [...allKnown].join(", ")
        }`
      );
    }
  }
  const restores = [];
  // Async fsp methods.
  for (const method of SUPPORTED_METHODS) {
    if (!faults[method]) continue;
    if (typeof fsp[method] !== "function") {
      throw new Error(`[fs-faulty] node:fs/promises has no method '${method}'`);
    }
    const original = fsp[method];
    const impl = buildAsyncSpyImpl(original, fsp, faults[method]);
    fsp[method] = impl;
    restores.push(() => {
      fsp[method] = original;
    });
  }
  // Sync fs methods.
  for (const method of SUPPORTED_SYNC_METHODS) {
    if (!faults[method]) continue;
    if (typeof fsModule[method] !== "function") {
      throw new Error(`[fs-faulty] node:fs has no method '${method}'`);
    }
    const original = fsModule[method];
    const impl = buildSyncSpyImpl(original, fsModule, faults[method]);
    fsModule[method] = impl;
    restores.push(() => {
      fsModule[method] = original;
    });
  }
  return {
    restore() {
      for (const fn of restores) fn();
    }
  };
}

module.exports = {
  installFaultyFs,
  SUPPORTED_METHODS,
  SUPPORTED_SYNC_METHODS
};
