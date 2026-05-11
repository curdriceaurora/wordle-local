"use strict";

// Self-tests for tests/helpers/fs-faulty.js (#129). Verifies the
// harness installs/restores spies correctly so downstream store
// fault-injection tests don't accidentally pass on a broken
// harness.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { installFaultyFs } = require("./helpers/fs-faulty");

function tempPath(name = "test.txt") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-fs-faulty-self-"));
  return { dir, filePath: path.join(dir, name) };
}

describe("fs-faulty: install/restore semantics", () => {
  test("restore() returns fsp.writeFile to the real implementation", async () => {
    const { dir, filePath } = tempPath();
    try {
      const before = fsp.writeFile;
      const fault = installFaultyFs({
        writeFile: { failAll: { code: "ENOSPC", message: "synthetic" } }
      });
      try {
        expect(fsp.writeFile).not.toBe(before);
        await expect(fsp.writeFile(filePath, "hello")).rejects.toMatchObject({
          code: "ENOSPC",
          message: "synthetic"
        });
      } finally {
        fault.restore();
      }
      // Identity restored; real I/O works again.
      expect(fsp.writeFile).toBe(before);
      await fsp.writeFile(filePath, "world", "utf8");
      expect(fs.readFileSync(filePath, "utf8")).toBe("world");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("failOnce only fires on the first call; subsequent calls pass through", async () => {
    const { dir, filePath } = tempPath();
    const filePath2 = path.join(dir, "second.txt");
    try {
      const fault = installFaultyFs({
        writeFile: { failOnce: { code: "EACCES", message: "blocked" } }
      });
      try {
        await expect(fsp.writeFile(filePath, "x")).rejects.toMatchObject({
          code: "EACCES"
        });
        // Second call passes through to real fsp.writeFile.
        await fsp.writeFile(filePath2, "y", "utf8");
        expect(fs.readFileSync(filePath2, "utf8")).toBe("y");
      } finally {
        fault.restore();
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("failIfPath only fails when the path matches", async () => {
    const { dir } = tempPath();
    const blockedPath = path.join(dir, "blocked.txt");
    const allowedPath = path.join(dir, "allowed.txt");
    try {
      const fault = installFaultyFs({
        writeFile: {
          failIfPath: {
            match: /blocked\.txt$/,
            error: { code: "EACCES", message: "blocked path" }
          }
        }
      });
      try {
        await expect(fsp.writeFile(blockedPath, "x")).rejects.toMatchObject({
          code: "EACCES"
        });
        // Different path passes through.
        await fsp.writeFile(allowedPath, "y", "utf8");
        expect(fs.readFileSync(allowedPath, "utf8")).toBe("y");
      } finally {
        fault.restore();
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("delay slows the call but doesn't fail it", async () => {
    const { dir, filePath } = tempPath();
    try {
      const fault = installFaultyFs({
        writeFile: { delay: 80 }
      });
      try {
        const start = Date.now();
        await fsp.writeFile(filePath, "x", "utf8");
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(70); // 80ms with 10ms tolerance for timer skew
      } finally {
        fault.restore();
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("multiple methods can be installed in one call", async () => {
    const { dir, filePath } = tempPath();
    try {
      const fault = installFaultyFs({
        writeFile: { failAll: { code: "ENOSPC" } },
        readFile: { failAll: { code: "EACCES" } }
      });
      try {
        await expect(fsp.writeFile(filePath, "x")).rejects.toMatchObject({
          code: "ENOSPC"
        });
        await expect(fsp.readFile(filePath)).rejects.toMatchObject({
          code: "EACCES"
        });
      } finally {
        fault.restore();
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("real Error objects pass through unchanged", async () => {
    const { dir, filePath } = tempPath();
    try {
      const original = new Error("custom");
      original.code = "EBUSY";
      const fault = installFaultyFs({
        writeFile: { failAll: original }
      });
      try {
        const caught = await fsp
          .writeFile(filePath, "x")
          .catch((err) => err);
        expect(caught).toBe(original);
      } finally {
        fault.restore();
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
