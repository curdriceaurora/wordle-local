const { isAuthorizedRequest, requireAdmin } = require("../lib/admin-auth");

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
