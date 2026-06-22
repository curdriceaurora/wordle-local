const { isAuthorizedRequest, checkAdminAuth, requireAdmin } = require("../lib/admin-auth");

function createResponseRecorder() {
  const recorder = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    }
  };
  return recorder;
}

describe("admin-auth", () => {
  test("isAuthorizedRequest respects optional admin mode when no key is configured", () => {
    const req = { headers: {} };
    const allowed = isAuthorizedRequest(req, {
      adminKey: "",
      requireAdminKey: false
    });
    expect(allowed).toBe(true);
  });

  test("isAuthorizedRequest denies when admin key is required but missing", () => {
    const req = { headers: {} };
    const allowed = isAuthorizedRequest(req, {
      adminKey: "",
      requireAdminKey: true
    });
    expect(allowed).toBe(false);
  });

  test("isAuthorizedRequest compares x-admin-key when configured", () => {
    const req = {
      headers: {
        "x-admin-key": "secret"
      }
    };
    const allowed = isAuthorizedRequest(req, {
      adminKey: "secret",
      requireAdminKey: true
    });
    expect(allowed).toBe(true);
  });

  test("isAuthorizedRequest denies when x-admin-key is incorrect", () => {
    const req = {
      headers: {
        "x-admin-key": "nope"
      }
    };
    const allowed = isAuthorizedRequest(req, {
      adminKey: "secret",
      requireAdminKey: true
    });
    expect(allowed).toBe(false);
  });

  test("requireAdmin middleware blocks unauthorized requests", () => {
    const req = { headers: {} };
    const res = createResponseRecorder();
    const next = jest.fn();
    const middleware = requireAdmin({
      adminKey: "secret",
      requireAdminKey: true
    });

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "Admin key required." });
  });

  test("requireAdmin middleware blocks incorrect admin key", () => {
    const req = {
      headers: {
        "x-admin-key": "wrong"
      }
    };
    const res = createResponseRecorder();
    const next = jest.fn();
    const middleware = requireAdmin({
      adminKey: "secret",
      requireAdminKey: true
    });

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "Admin key required." });
  });

  test("requireAdmin middleware forwards authorized requests", () => {
    const req = {
      headers: {
        "x-admin-key": "secret"
      }
    };
    const res = createResponseRecorder();
    const next = jest.fn();
    const middleware = requireAdmin({
      adminKey: "secret",
      requireAdminKey: true
    });

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(res.payload).toBeNull();
  });
});

// #204: dual-accept rotation window.
//
// The admin auth gate accepts EITHER the current `adminKey` OR a
// configured `adminKeyPrevious` while `Date.now() <
// adminKeyRotationExpiresAt`. After the timestamp passes, only the
// current key is accepted. `now` is injectable for deterministic
// tests.
describe("admin-auth — dual-accept rotation window (#204)", () => {
  const baseConfig = {
    adminKey: "NEW_KEY_value_2026",
    adminKeyPrevious: "OLD_KEY_value_2025",
    adminKeyRotationExpiresAt: "2026-06-01T00:00:00.000Z",
    requireAdminKey: true,
    now: () => new Date("2026-05-15T12:00:00.000Z").getTime()
  };

  function reqWith(key) {
    return { headers: { "x-admin-key": key }, id: "test-rid-001", method: "GET", path: "/api/admin/x" };
  }

  describe("during the rotation window", () => {
    test("current key is accepted (mode: 'current')", () => {
      const result = checkAdminAuth(reqWith("NEW_KEY_value_2026"), baseConfig);
      expect(result).toMatchObject({ ok: true, mode: "current" });
    });

    test("previous key is accepted (mode: 'previous') with msRemaining", () => {
      const result = checkAdminAuth(reqWith("OLD_KEY_value_2025"), baseConfig);
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("previous");
      expect(typeof result.msRemaining).toBe("number");
      expect(result.msRemaining).toBeGreaterThan(0);
      expect(typeof result.expiresAt).toBe("number");
    });

    test("an unrelated key is rejected", () => {
      const result = checkAdminAuth(reqWith("not-either-key"), baseConfig);
      expect(result).toEqual({ ok: false, mode: "rejected" });
    });

    test("empty header is rejected", () => {
      const result = checkAdminAuth({ headers: {} }, baseConfig);
      expect(result).toEqual({ ok: false, mode: "rejected" });
    });
  });

  describe("after the rotation window expires", () => {
    const expiredConfig = {
      ...baseConfig,
      now: () => new Date("2026-07-01T00:00:00.000Z").getTime() // after expiresAt
    };

    test("current key still works", () => {
      const result = checkAdminAuth(reqWith("NEW_KEY_value_2026"), expiredConfig);
      expect(result).toMatchObject({ ok: true, mode: "current" });
    });

    test("previous key is REJECTED (rotation expired)", () => {
      const result = checkAdminAuth(reqWith("OLD_KEY_value_2025"), expiredConfig);
      expect(result).toEqual({ ok: false, mode: "rejected" });
    });
  });

  describe("config edge cases", () => {
    test("no adminKeyPrevious: only current key accepted (rotation disabled)", () => {
      const config = { ...baseConfig, adminKeyPrevious: "" };
      expect(checkAdminAuth(reqWith("NEW_KEY_value_2026"), config).ok).toBe(true);
      expect(checkAdminAuth(reqWith("OLD_KEY_value_2025"), config).ok).toBe(false);
    });

    test("no adminKeyRotationExpiresAt: previous key has no window, rejected", () => {
      // Defense-in-depth: we require BOTH previous + expiresAt. An
      // unbounded "previous" key would be a forever-live shadow
      // credential — exactly what rotation is trying to retire.
      const config = { ...baseConfig, adminKeyRotationExpiresAt: "" };
      expect(checkAdminAuth(reqWith("OLD_KEY_value_2025"), config).ok).toBe(false);
    });

    test("invalid adminKeyRotationExpiresAt (unparseable): previous key rejected", () => {
      const config = { ...baseConfig, adminKeyRotationExpiresAt: "not-a-date" };
      expect(checkAdminAuth(reqWith("OLD_KEY_value_2025"), config).ok).toBe(false);
    });

    test("numeric adminKeyRotationExpiresAt (epoch ms) also accepted", () => {
      const config = {
        ...baseConfig,
        adminKeyRotationExpiresAt: new Date("2026-06-01T00:00:00.000Z").getTime()
      };
      expect(checkAdminAuth(reqWith("OLD_KEY_value_2025"), config).ok).toBe(true);
    });

    test("digit-only string adminKeyRotationExpiresAt (epoch ms as env var) accepted", () => {
      // process.env values are always strings, so this is the real
      // production shape — not the JS-number case above, which
      // `Date.parse()` would mishandle (it returns NaN for pure-digit
      // strings, since they aren't a recognized date format).
      const config = {
        ...baseConfig,
        adminKeyRotationExpiresAt: String(new Date("2026-06-01T00:00:00.000Z").getTime())
      };
      expect(checkAdminAuth(reqWith("OLD_KEY_value_2025"), config).ok).toBe(true);
    });

    test("admin auth disabled (no adminKey, requireAdminKey=false): bypassed", () => {
      const config = {
        adminKey: "",
        adminKeyPrevious: "",
        adminKeyRotationExpiresAt: "",
        requireAdminKey: false
      };
      expect(checkAdminAuth({ headers: {} }, config)).toEqual({
        ok: true,
        mode: "no-key-required"
      });
    });
  });

  describe("requireAdmin middleware — structured log on previous-key acceptance", () => {
    test("emits admin.auth.previous_key_used with no secret value when previous key used", () => {
      const logs = [];
      const logger = {
        info: (msg, fields) => logs.push({ msg, fields })
      };
      const middleware = requireAdmin({ ...baseConfig, logger });
      const req = reqWith("OLD_KEY_value_2025");
      const res = createResponseRecorder();
      const next = jest.fn();
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(logs).toHaveLength(1);
      expect(logs[0].msg).toBe("admin.auth.previous_key_used");
      expect(logs[0].fields.requestId).toBe("test-rid-001");
      expect(logs[0].fields.method).toBe("GET");
      expect(logs[0].fields.path).toBe("/api/admin/x");
      expect(typeof logs[0].fields.msRemaining).toBe("number");
      expect(typeof logs[0].fields.expiresAt).toBe("string");
      // CRITICAL: never log the secret values. Verify neither
      // adminKey nor adminKeyPrevious appears anywhere in the log
      // payload.
      const flat = JSON.stringify(logs[0]);
      expect(flat).not.toContain("OLD_KEY_value_2025");
      expect(flat).not.toContain("NEW_KEY_value_2026");
    });

    test("does NOT emit the log when current key is used (only previous-key usage is logged)", () => {
      const logs = [];
      const logger = { info: (msg, fields) => logs.push({ msg, fields }) };
      const middleware = requireAdmin({ ...baseConfig, logger });
      const req = reqWith("NEW_KEY_value_2026");
      const res = createResponseRecorder();
      const next = jest.fn();
      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(logs).toHaveLength(0);
    });

    test("does NOT log when previous key used AFTER expiry (request is 401, not logged)", () => {
      const logs = [];
      const logger = { info: (msg, fields) => logs.push({ msg, fields }) };
      const middleware = requireAdmin({
        ...baseConfig,
        now: () => new Date("2026-07-01T00:00:00.000Z").getTime(),
        logger
      });
      const req = reqWith("OLD_KEY_value_2025");
      const res = createResponseRecorder();
      const next = jest.fn();
      middleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(logs).toHaveLength(0);
    });

    test("works without a logger (graceful no-op on previous-key path)", () => {
      // Some callers may not inject a logger (older tests). The
      // middleware must not crash when result.mode === "previous"
      // and logger is missing.
      const middleware = requireAdmin({ ...baseConfig, logger: undefined });
      const req = reqWith("OLD_KEY_value_2025");
      const res = createResponseRecorder();
      const next = jest.fn();
      expect(() => middleware(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
