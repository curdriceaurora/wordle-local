const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ClassesStore,
  ClassesStoreError,
  createEmptyClassesState,
  normalizeClassesState,
  normalizeClassName
} = require("../lib/classes-store");

const createdTempDirs = [];

function tempFilePath(name = "classes.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-classes-"));
  createdTempDirs.push(dir);
  return path.join(dir, name);
}

afterAll(() => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_err) {
      // best effort
    }
  }
});

function silentLogger() {
  return { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
}

function isoAt(daysFromEpoch) {
  return new Date(daysFromEpoch * 24 * 60 * 60 * 1000).toISOString();
}

function createClock(initialMs = Date.UTC(2026, 0, 1)) {
  let cursor = initialMs;
  return {
    now: () => new Date(cursor),
    advance(ms = 1000) {
      cursor += ms;
      return cursor;
    }
  };
}

function readState(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("normalizeClassName", () => {
  test("trims whitespace and accepts unicode letters", () => {
    expect(normalizeClassName("  Mr. Garcia's Class  ")).toBe("Mr. Garcia's Class");
    expect(normalizeClassName("3年A組")).toBe("3年A組");
  });

  test("rejects empty, too long, and control-char names", () => {
    expect(normalizeClassName("")).toBeNull();
    expect(normalizeClassName("   ")).toBeNull();
    expect(normalizeClassName("a".repeat(65))).toBeNull();
    expect(normalizeClassName("Bad\nName")).toBeNull();
    expect(normalizeClassName("Tab\tName")).toBeNull();
    expect(normalizeClassName(123)).toBeNull();
    expect(normalizeClassName(null)).toBeNull();
  });
});

describe("classes-store: load and recovery", () => {
  test("creates default state file when missing", async () => {
    const filePath = tempFilePath();
    const store = new ClassesStore({ filePath, logger: silentLogger() });

    const snapshot = await store.getSnapshot();

    expect(snapshot.version).toBe(1);
    expect(snapshot.classes).toEqual([]);
    expect(typeof snapshot.updatedAt).toBe("string");
    expect(fs.existsSync(filePath)).toBe(true);
    const onDisk = readState(filePath);
    expect(onDisk.classes).toEqual([]);
  });

  test("recovers malformed JSON to empty state", async () => {
    const filePath = tempFilePath();
    fs.writeFileSync(filePath, "{not-json", "utf8");
    const logger = silentLogger();
    const store = new ClassesStore({ filePath, logger });

    const snapshot = await store.getSnapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.classes).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("rejects unsupported on-disk schema version", async () => {
    const filePath = tempFilePath();
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ version: 2, updatedAt: isoAt(1), classes: [] })}\n`,
      "utf8"
    );
    const store = new ClassesStore({ filePath, logger: silentLogger() });
    await expect(store.getSnapshot()).rejects.toThrow(/Unsupported classes schema version/);
  });

  test("strips invalid records and duplicates", async () => {
    const filePath = tempFilePath();
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        version: 1,
        updatedAt: isoAt(1),
        classes: [
          {
            id: "class-aaaaaaaaaaaa",
            name: "Class A",
            createdAt: isoAt(1),
            updatedAt: isoAt(1),
            archivedAt: null,
            memberProfileIds: ["p1", "p1", "p2"]
          },
          // Duplicate id
          {
            id: "class-aaaaaaaaaaaa",
            name: "Other",
            createdAt: isoAt(2),
            updatedAt: isoAt(2),
            memberProfileIds: []
          },
          // Duplicate name (case-insensitive)
          {
            id: "class-bbbbbbbbbbbb",
            name: "class a",
            createdAt: isoAt(3),
            updatedAt: isoAt(3),
            memberProfileIds: []
          },
          // Invalid id pattern
          {
            id: "not-a-class-id",
            name: "Bad",
            createdAt: isoAt(4),
            updatedAt: isoAt(4),
            memberProfileIds: []
          }
        ]
      })}\n`,
      "utf8"
    );
    const store = new ClassesStore({ filePath, logger: silentLogger() });
    const snapshot = await store.getSnapshot();
    expect(snapshot.classes).toHaveLength(1);
    expect(snapshot.classes[0].id).toBe("class-aaaaaaaaaaaa");
    expect(snapshot.classes[0].memberProfileIds).toEqual(["p1", "p2"]);
  });
});

describe("classes-store: createClass / updateClass / deleteClass", () => {
  test("creates a class with normalized name and persists", async () => {
    const filePath = tempFilePath();
    const clock = createClock();
    const store = new ClassesStore({ filePath, logger: silentLogger(), now: clock.now });

    const created = await store.createClass("  Period 1 Math  ");
    expect(created.id).toMatch(/^class-/);
    expect(created.name).toBe("Period 1 Math");
    expect(created.archivedAt).toBeNull();
    expect(created.memberProfileIds).toEqual([]);

    const persisted = readState(filePath);
    expect(persisted.classes).toHaveLength(1);
    expect(persisted.classes[0].name).toBe("Period 1 Math");
  });

  test("rejects creating with invalid or duplicate names", async () => {
    const store = new ClassesStore({ filePath: tempFilePath(), logger: silentLogger() });
    await expect(store.createClass("")).rejects.toMatchObject({ code: "INVALID_NAME" });
    await store.createClass("Section A");
    await expect(store.createClass("section a")).rejects.toMatchObject({ code: "DUPLICATE_NAME" });
  });

  test("rejects creating beyond maxClasses", async () => {
    const store = new ClassesStore({
      filePath: tempFilePath(),
      logger: silentLogger(),
      maxClasses: 2
    });
    await store.createClass("A");
    await store.createClass("B");
    await expect(store.createClass("C")).rejects.toMatchObject({ code: "MAX_CLASSES_REACHED" });
  });

  test("renames and archives classes", async () => {
    const clock = createClock();
    const store = new ClassesStore({
      filePath: tempFilePath(),
      logger: silentLogger(),
      now: clock.now
    });
    const created = await store.createClass("Original");
    clock.advance();
    const renamed = await store.updateClass(created.id, { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    clock.advance();
    const archived = await store.updateClass(created.id, { archived: true });
    expect(archived.archivedAt).toBeTruthy();
    clock.advance();
    const unarchived = await store.updateClass(created.id, { archived: false });
    expect(unarchived.archivedAt).toBeNull();
  });

  test("rename rejects collision with existing class name", async () => {
    const store = new ClassesStore({ filePath: tempFilePath(), logger: silentLogger() });
    const a = await store.createClass("Class A");
    await store.createClass("Class B");
    await expect(
      store.updateClass(a.id, { name: "class b" })
    ).rejects.toMatchObject({ code: "DUPLICATE_NAME" });
  });

  test("deleteClass removes the entry", async () => {
    const filePath = tempFilePath();
    const store = new ClassesStore({ filePath, logger: silentLogger() });
    const created = await store.createClass("Doomed");
    await store.deleteClass(created.id);
    expect(await store.getClass(created.id)).toBeNull();
    expect(readState(filePath).classes).toHaveLength(0);
  });

  test("deleteClass throws CLASS_NOT_FOUND for unknown id", async () => {
    const store = new ClassesStore({ filePath: tempFilePath(), logger: silentLogger() });
    await expect(store.deleteClass("class-missing-1234")).rejects.toMatchObject({
      code: "CLASS_NOT_FOUND"
    });
  });
});

describe("classes-store: members", () => {
  test("addMembers is idempotent on duplicate ids", async () => {
    const store = new ClassesStore({ filePath: tempFilePath(), logger: silentLogger() });
    const created = await store.createClass("Group 1");
    const first = await store.addMembers(created.id, ["p1", "p2", "p1"]);
    expect(first.added).toEqual(["p1", "p2"]);
    expect(first.class.memberProfileIds).toEqual(["p1", "p2"]);

    const second = await store.addMembers(created.id, ["p2", "p3"]);
    expect(second.added).toEqual(["p3"]);
    expect(second.class.memberProfileIds).toEqual(["p1", "p2", "p3"]);
  });

  test("addMembers refuses to write to an archived class", async () => {
    const store = new ClassesStore({ filePath: tempFilePath(), logger: silentLogger() });
    const created = await store.createClass("Old Class");
    await store.updateClass(created.id, { archived: true });
    await expect(store.addMembers(created.id, ["p1"])).rejects.toMatchObject({
      code: "CLASS_ARCHIVED"
    });
  });

  test("addMembers enforces per-class member cap", async () => {
    const store = new ClassesStore({
      filePath: tempFilePath(),
      logger: silentLogger(),
      maxMembersPerClass: 2
    });
    const created = await store.createClass("Tiny Class");
    await store.addMembers(created.id, ["p1", "p2"]);
    await expect(store.addMembers(created.id, ["p3"])).rejects.toMatchObject({
      code: "MAX_MEMBERS_REACHED"
    });
  });

  test("removeMember and removeMemberEverywhere work", async () => {
    const store = new ClassesStore({ filePath: tempFilePath(), logger: silentLogger() });
    const a = await store.createClass("Alpha");
    const b = await store.createClass("Beta");
    await store.addMembers(a.id, ["p1", "p2"]);
    await store.addMembers(b.id, ["p1", "p3"]);

    const updated = await store.removeMember(a.id, "p1");
    expect(updated.memberProfileIds).toEqual(["p2"]);
    await expect(store.removeMember(a.id, "p99")).rejects.toMatchObject({
      code: "MEMBER_NOT_FOUND"
    });

    const removedCount = await store.removeMemberEverywhere("p1");
    expect(removedCount).toBe(1);
    const bAfter = await store.getClass(b.id);
    expect(bAfter.memberProfileIds).toEqual(["p3"]);
  });
});

describe("classes-store: listClasses", () => {
  test("excludes archived classes by default", async () => {
    const store = new ClassesStore({ filePath: tempFilePath(), logger: silentLogger() });
    const a = await store.createClass("Active");
    const b = await store.createClass("Archived");
    await store.updateClass(b.id, { archived: true });

    const visible = await store.listClasses();
    expect(visible.map((entry) => entry.id)).toEqual([a.id]);

    const all = await store.listClasses({ includeArchived: true });
    expect(all.map((entry) => entry.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("classes-store: normalizeClassesState", () => {
  test("flags wasPruned when over maxClasses", () => {
    const payload = {
      version: 1,
      updatedAt: isoAt(1),
      classes: Array.from({ length: 5 }, (_, idx) => ({
        id: `class-${"a".repeat(11)}${idx}`,
        name: `Class ${idx}`,
        createdAt: isoAt(idx + 1),
        updatedAt: isoAt(idx + 1),
        archivedAt: null,
        memberProfileIds: []
      }))
    };
    const result = normalizeClassesState(payload, { maxClasses: 3 });
    expect(result.wasPruned).toBe(true);
    expect(result.state.classes).toHaveLength(3);
  });

  test("returns empty state for non-object input", () => {
    const result = normalizeClassesState(null);
    expect(result.state).toEqual(createEmptyClassesState());
    expect(result.hadInvalidContent).toBe(true);
  });
});

describe("classes-store: error class", () => {
  test("ClassesStoreError carries code", () => {
    const err = new ClassesStoreError("TEST_CODE", "test message");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
  });
});
