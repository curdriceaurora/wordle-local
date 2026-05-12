"use strict";

const {
  requestContext,
  getRequestId,
  runWithRequestId
} = require("../lib/request-context");

describe("requestContext / getRequestId", () => {
  test("returns null outside any run() scope", () => {
    expect(getRequestId()).toBeNull();
  });

  test("returns the ID set by runWithRequestId", () => {
    let captured = null;
    runWithRequestId("abc-123", () => {
      captured = getRequestId();
    });
    expect(captured).toBe("abc-123");
    // And outside the scope again, null.
    expect(getRequestId()).toBeNull();
  });

  test("nested run() shadows the outer ID for the duration of the inner block", () => {
    const outer = [];
    runWithRequestId("outer", () => {
      outer.push(getRequestId());
      runWithRequestId("inner", () => {
        outer.push(getRequestId());
      });
      outer.push(getRequestId());
    });
    expect(outer).toEqual(["outer", "inner", "outer"]);
  });

  test("ID survives across awaited promise boundaries", async () => {
    const result = await new Promise((resolve) => {
      runWithRequestId("await-friendly", () => {
        setImmediate(async () => {
          await Promise.resolve();
          resolve(getRequestId());
        });
      });
    });
    expect(result).toBe("await-friendly");
  });

  test("two concurrent runs don't leak IDs into each other", async () => {
    const ids = await Promise.all([
      new Promise((resolve) => {
        runWithRequestId("alpha", () => {
          setImmediate(() => resolve(getRequestId()));
        });
      }),
      new Promise((resolve) => {
        runWithRequestId("beta", () => {
          setImmediate(() => resolve(getRequestId()));
        });
      })
    ]);
    expect(ids).toEqual(["alpha", "beta"]);
  });

  test("getRequestId tolerates store with missing/invalid requestId field", () => {
    requestContext.run({ requestId: "" }, () => {
      expect(getRequestId()).toBeNull();
    });
    requestContext.run({ requestId: 42 }, () => {
      expect(getRequestId()).toBeNull();
    });
    requestContext.run({}, () => {
      expect(getRequestId()).toBeNull();
    });
  });
});
