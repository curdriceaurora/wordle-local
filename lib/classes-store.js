const fs = require("fs");
const path = require("path");
const nodeCrypto = require("node:crypto");

const fsp = fs.promises;

const DEFAULT_FILE_PATH = path.join(__dirname, "..", "data", "classes.json");
const DEFAULT_SCHEMA_VERSION = 1;
const EPOCH_ISO = new Date(0).toISOString();
const DEFAULT_MAX_CLASSES = 200;
const DEFAULT_MAX_MEMBERS_PER_CLASS = 1000;

const CLASS_ID_PATTERN = /^class-[a-f0-9-]{12,64}$/;
const CLASS_NAME_MIN = 1;
const CLASS_NAME_MAX = 64;
const PROFILE_ID_MAX = 64;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CLASS_ALLOWED_KEYS = new Set([
  "id",
  "name",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "memberProfileIds"
]);

class ClassesStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ClassesStoreError";
    this.code = code;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (!ISO_DATE_TIME_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function normalizeClassName(rawName) {
  if (typeof rawName !== "string") return null;
  const trimmed = rawName.trim();
  if (trimmed.length < CLASS_NAME_MIN || trimmed.length > CLASS_NAME_MAX) {
    return null;
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return null;
    }
  }
  return trimmed;
}

function normalizeClassRecord(rawClass, options = {}) {
  if (!isObject(rawClass)) return null;

  const maxMembersPerClass =
    Number.isInteger(options.maxMembersPerClass) && options.maxMembersPerClass >= 1
      ? options.maxMembersPerClass
      : DEFAULT_MAX_MEMBERS_PER_CLASS;

  const id = typeof rawClass.id === "string" ? rawClass.id.trim() : "";
  if (!CLASS_ID_PATTERN.test(id)) return null;

  const name = normalizeClassName(rawClass.name);
  if (!name) return null;

  const createdAt = isIsoTimestamp(rawClass.createdAt) ? rawClass.createdAt : null;
  const updatedAt = isIsoTimestamp(rawClass.updatedAt) ? rawClass.updatedAt : null;
  if (!createdAt || !updatedAt) return null;

  let archivedAt = null;
  if (rawClass.archivedAt !== undefined && rawClass.archivedAt !== null) {
    if (!isIsoTimestamp(rawClass.archivedAt)) return null;
    archivedAt = rawClass.archivedAt;
  }

  if (!Array.isArray(rawClass.memberProfileIds)) return null;
  const memberProfileIds = [];
  const seen = new Set();
  for (const candidate of rawClass.memberProfileIds) {
    if (typeof candidate !== "string") return null;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > PROFILE_ID_MAX) return null;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    memberProfileIds.push(trimmed);
  }

  let memberWasPruned = false;
  if (memberProfileIds.length > maxMembersPerClass) {
    memberProfileIds.length = maxMembersPerClass;
    memberWasPruned = true;
  }

  return {
    record: {
      id,
      name,
      createdAt,
      updatedAt,
      archivedAt,
      memberProfileIds
    },
    memberWasPruned
  };
}

function createEmptyClassesState() {
  return {
    version: DEFAULT_SCHEMA_VERSION,
    updatedAt: EPOCH_ISO,
    classes: []
  };
}

function normalizeClassesState(rawState, options = {}) {
  const fallback = createEmptyClassesState();
  const maxClasses =
    Number.isInteger(options.maxClasses) && options.maxClasses >= 1
      ? options.maxClasses
      : DEFAULT_MAX_CLASSES;
  const maxMembersPerClass =
    Number.isInteger(options.maxMembersPerClass) && options.maxMembersPerClass >= 1
      ? options.maxMembersPerClass
      : DEFAULT_MAX_MEMBERS_PER_CLASS;

  let hadInvalidContent = false;
  let wasPruned = false;

  if (!isObject(rawState)) {
    return { state: fallback, hadInvalidContent: true, wasPruned: false };
  }

  if (rawState.version !== DEFAULT_SCHEMA_VERSION) {
    hadInvalidContent = true;
  }

  const updatedAt = isIsoTimestamp(rawState.updatedAt) ? rawState.updatedAt : EPOCH_ISO;
  if (updatedAt !== rawState.updatedAt) {
    hadInvalidContent = true;
  }

  const rawClasses = Array.isArray(rawState.classes) ? rawState.classes : [];
  if (!Array.isArray(rawState.classes)) {
    hadInvalidContent = true;
  }

  const classes = [];
  const seenIds = new Set();
  const seenNames = new Set();

  for (const candidate of rawClasses) {
    const normalized = normalizeClassRecord(candidate, { maxMembersPerClass });
    if (!normalized) {
      hadInvalidContent = true;
      continue;
    }
    if (normalized.memberWasPruned) {
      wasPruned = true;
    }
    const record = normalized.record;
    if (seenIds.has(record.id)) {
      hadInvalidContent = true;
      continue;
    }
    const nameKey = record.name.toLowerCase();
    if (seenNames.has(nameKey)) {
      hadInvalidContent = true;
      continue;
    }
    if (Object.keys(candidate).some((key) => !CLASS_ALLOWED_KEYS.has(key))) {
      hadInvalidContent = true;
    }
    seenIds.add(record.id);
    seenNames.add(nameKey);
    classes.push(record);
  }

  classes.sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id.localeCompare(right.id);
    }
    return left.createdAt.localeCompare(right.createdAt);
  });

  let prunedClasses = classes;
  if (classes.length > maxClasses) {
    prunedClasses = classes.slice(classes.length - maxClasses);
    wasPruned = true;
  }

  return {
    state: {
      version: DEFAULT_SCHEMA_VERSION,
      updatedAt,
      classes: prunedClasses
    },
    hadInvalidContent,
    wasPruned
  };
}

class ClassesStore {
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_FILE_PATH;
    this.maxClasses =
      Number.isInteger(options.maxClasses) && options.maxClasses >= 1
        ? options.maxClasses
        : DEFAULT_MAX_CLASSES;
    this.maxMembersPerClass =
      Number.isInteger(options.maxMembersPerClass) && options.maxMembersPerClass >= 1
        ? options.maxMembersPerClass
        : DEFAULT_MAX_MEMBERS_PER_CLASS;
    this.logger = options.logger || console;
    this.now = typeof options.now === "function" ? options.now : () => new Date();

    this.state = null;
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.state) {
      return clone(this.state);
    }
    if (!this.loadPromise) {
      // Clear the cached promise on rejection so a transient read/write
      // failure during initial recovery doesn't wedge the store for the
      // process lifetime — the next caller can retry.
      this.loadPromise = this.#loadInternal().catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    }
    await this.loadPromise;
    return clone(this.state);
  }

  async getSnapshot() {
    await this.load();
    return clone(this.state);
  }

  async listClasses(options = {}) {
    await this.load();
    const includeArchived = options.includeArchived === true;
    return this.state.classes
      .filter((entry) => includeArchived || !entry.archivedAt)
      .map((entry) => clone(entry));
  }

  async getClass(classId) {
    await this.load();
    const id = String(classId || "").trim();
    if (!id) return null;
    const found = this.state.classes.find((entry) => entry.id === id);
    return found ? clone(found) : null;
  }

  async createClass(name) {
    const normalized = normalizeClassName(name);
    if (!normalized) {
      throw new ClassesStoreError(
        "INVALID_NAME",
        `Class name must be a 1-${CLASS_NAME_MAX} character string with no control characters.`
      );
    }
    return this.#enqueueWrite(async () => {
      if (this.state.classes.length >= this.maxClasses) {
        throw new ClassesStoreError(
          "MAX_CLASSES_REACHED",
          `Cannot create more than ${this.maxClasses} classes on this host.`
        );
      }
      const nameKey = normalized.toLowerCase();
      if (this.state.classes.some((entry) => entry.name.toLowerCase() === nameKey)) {
        throw new ClassesStoreError(
          "DUPLICATE_NAME",
          "Another class already uses that name."
        );
      }
      const nowIso = this.now().toISOString();
      const created = {
        id: `class-${nodeCrypto.randomUUID()}`,
        name: normalized,
        createdAt: nowIso,
        updatedAt: nowIso,
        archivedAt: null,
        memberProfileIds: []
      };
      this.state.classes.push(created);
      this.state.classes.sort((left, right) => {
        if (left.createdAt === right.createdAt) {
          return left.id.localeCompare(right.id);
        }
        return left.createdAt.localeCompare(right.createdAt);
      });
      await this.#persist();
      return clone(created);
    });
  }

  async updateClass(classId, patch) {
    if (!isObject(patch)) {
      throw new ClassesStoreError("INVALID_REQUEST", "patch must be an object.");
    }
    return this.#enqueueWrite(async () => {
      const target = this.#requireClass(classId);
      const nowIso = this.now().toISOString();

      if (patch.name !== undefined) {
        const normalized = normalizeClassName(patch.name);
        if (!normalized) {
          throw new ClassesStoreError(
            "INVALID_NAME",
            `Class name must be a 1-${CLASS_NAME_MAX} character string.`
          );
        }
        const nameKey = normalized.toLowerCase();
        if (
          this.state.classes.some(
            (entry) => entry.id !== target.id && entry.name.toLowerCase() === nameKey
          )
        ) {
          throw new ClassesStoreError(
            "DUPLICATE_NAME",
            "Another class already uses that name."
          );
        }
        target.name = normalized;
      }

      if (patch.archived !== undefined) {
        if (typeof patch.archived !== "boolean") {
          throw new ClassesStoreError(
            "INVALID_REQUEST",
            "archived must be true or false."
          );
        }
        target.archivedAt = patch.archived ? nowIso : null;
      }

      target.updatedAt = nowIso;
      await this.#persist();
      return clone(target);
    });
  }

  async deleteClass(classId) {
    const id = String(classId || "").trim();
    return this.#enqueueWrite(async () => {
      const index = this.state.classes.findIndex((entry) => entry.id === id);
      if (index === -1) {
        throw new ClassesStoreError("CLASS_NOT_FOUND", "Class not found.");
      }
      const removed = clone(this.state.classes[index]);
      this.state.classes.splice(index, 1);
      await this.#persist();
      return removed;
    });
  }

  // Atomically (under the classes-store write lock) deletes the named class
  // and computes the carve-out set: member profile IDs that were members of
  // this class and are NOT members of any other non-archived class. Those
  // carve-out IDs are also removed from any archived classes that still
  // reference them, so the on-disk classes file is consistent before the
  // caller hands the IDs to the leaderboard store for profile deletion.
  async deleteClassWithCarveOut(classId) {
    const id = String(classId || "").trim();
    return this.#enqueueWrite(async () => {
      const index = this.state.classes.findIndex((entry) => entry.id === id);
      if (index === -1) {
        throw new ClassesStoreError("CLASS_NOT_FOUND", "Class not found.");
      }
      const target = this.state.classes[index];
      const memberIds = target.memberProfileIds.slice();

      const otherActiveMembership = new Set();
      for (const entry of this.state.classes) {
        if (entry.id === id) continue;
        if (entry.archivedAt) continue;
        for (const memberId of entry.memberProfileIds) {
          otherActiveMembership.add(memberId);
        }
      }

      const carveOutIds = memberIds.filter((cid) => !otherActiveMembership.has(cid));
      const carveOutSet = new Set(carveOutIds);

      const nowIso = this.now().toISOString();
      for (const entry of this.state.classes) {
        if (entry.id === id) continue;
        if (carveOutSet.size === 0) break;
        const filtered = entry.memberProfileIds.filter((cid) => !carveOutSet.has(cid));
        if (filtered.length !== entry.memberProfileIds.length) {
          entry.memberProfileIds = filtered;
          entry.updatedAt = nowIso;
        }
      }

      const removed = clone(target);
      this.state.classes.splice(index, 1);
      await this.#persist();
      return { removed, carveOutIds };
    });
  }

  // Atomically replace every reference to `oldProfileId` across every class
  // with `newProfileId`, deduping if the new id is already a member. Used by
  // the profile-merge route so a merged profile inherits the class
  // memberships of its source.
  async replaceMemberEverywhere(oldProfileId, newProfileId) {
    return this.#enqueueWrite(async () => {
      const oldId = String(oldProfileId || "").trim();
      const newId = String(newProfileId || "").trim();
      if (!oldId || !newId) {
        throw new ClassesStoreError(
          "INVALID_REQUEST",
          "Both oldProfileId and newProfileId are required."
        );
      }
      let touched = 0;
      const touchedClassIds = [];
      const nowIso = this.now().toISOString();
      for (const entry of this.state.classes) {
        const oldIdx = entry.memberProfileIds.indexOf(oldId);
        if (oldIdx === -1) continue;
        const hasNew = entry.memberProfileIds.includes(newId);
        if (hasNew) {
          entry.memberProfileIds.splice(oldIdx, 1);
        } else {
          entry.memberProfileIds[oldIdx] = newId;
        }
        entry.updatedAt = nowIso;
        touched += 1;
        touchedClassIds.push(entry.id);
      }
      if (touched > 0) {
        await this.#persist();
      }
      return { touched, touchedClassIds };
    });
  }

  async addMembers(classId, profileIds) {
    if (!Array.isArray(profileIds)) {
      throw new ClassesStoreError(
        "INVALID_REQUEST",
        "profileIds must be an array."
      );
    }
    return this.#enqueueWrite(async () => {
      const target = this.#requireClass(classId);
      if (target.archivedAt) {
        throw new ClassesStoreError(
          "CLASS_ARCHIVED",
          "Cannot add members to an archived class. Unarchive it first."
        );
      }
      const existing = new Set(target.memberProfileIds);
      const added = [];
      for (const candidate of profileIds) {
        if (typeof candidate !== "string") continue;
        const id = candidate.trim();
        if (!id || id.length > PROFILE_ID_MAX) continue;
        if (existing.has(id)) continue;
        if (target.memberProfileIds.length + added.length >= this.maxMembersPerClass) {
          throw new ClassesStoreError(
            "MAX_MEMBERS_REACHED",
            `Class is at the per-class member cap of ${this.maxMembersPerClass}.`
          );
        }
        existing.add(id);
        added.push(id);
      }
      if (added.length > 0) {
        target.memberProfileIds.push(...added);
        target.updatedAt = this.now().toISOString();
        await this.#persist();
      }
      return { class: clone(target), added };
    });
  }

  async removeMember(classId, profileId) {
    return this.#enqueueWrite(async () => {
      const target = this.#requireClass(classId);
      const idx = target.memberProfileIds.indexOf(profileId);
      if (idx === -1) {
        throw new ClassesStoreError("MEMBER_NOT_FOUND", "Profile is not a member of this class.");
      }
      target.memberProfileIds.splice(idx, 1);
      target.updatedAt = this.now().toISOString();
      await this.#persist();
      return clone(target);
    });
  }

  async removeMemberEverywhere(profileId) {
    return this.#enqueueWrite(async () => {
      let touched = 0;
      const nowIso = this.now().toISOString();
      for (const entry of this.state.classes) {
        const idx = entry.memberProfileIds.indexOf(profileId);
        if (idx !== -1) {
          entry.memberProfileIds.splice(idx, 1);
          entry.updatedAt = nowIso;
          touched += 1;
        }
      }
      if (touched > 0) {
        await this.#persist();
      }
      return touched;
    });
  }

  #requireClass(classId) {
    const id = String(classId || "").trim();
    const target = this.state.classes.find((entry) => entry.id === id);
    if (!target) {
      throw new ClassesStoreError("CLASS_NOT_FOUND", "Class not found.");
    }
    return target;
  }

  async #enqueueWrite(operation) {
    await this.load();
    const run = async () => {
      // Snapshot live state so we can restore on persist failure. Without
      // this, a writeFile/rename failure leaves dirty in-memory state that
      // can be observed by subsequent reads even though it never reached
      // disk.
      const snapshot = clone(this.state);
      try {
        return await operation();
      } catch (err) {
        this.state = snapshot;
        throw err;
      }
    };
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async #loadInternal() {
    const emptyState = createEmptyClassesState();
    let rawState = null;
    let needsPersist = false;

    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      rawState = JSON.parse(raw);
      if (
        isObject(rawState) &&
        Number.isInteger(rawState.version) &&
        rawState.version !== DEFAULT_SCHEMA_VERSION
      ) {
        throw new Error(`Unsupported classes schema version: ${rawState.version}`);
      }
    } catch (err) {
      if (err && err.code === "ENOENT") {
        rawState = emptyState;
        needsPersist = true;
      } else if (err instanceof SyntaxError) {
        this.logger.warn("Classes store file is invalid JSON. Resetting to empty state.");
        rawState = emptyState;
        needsPersist = true;
      } else {
        throw err;
      }
    }

    const { state, hadInvalidContent, wasPruned } = normalizeClassesState(rawState, {
      maxClasses: this.maxClasses,
      maxMembersPerClass: this.maxMembersPerClass
    });

    if (hadInvalidContent || wasPruned) {
      needsPersist = true;
      this.logger.warn("Classes store contained invalid or excess entries and was normalized.");
    }

    this.state = state;
    if (needsPersist) {
      await this.#persist();
    }
  }

  async #persist() {
    this.state.updatedAt = this.now().toISOString();
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    const tempPath = `${this.filePath}.tmp`;

    await fsp.writeFile(tempPath, payload, "utf8");
    try {
      await fsp.rename(tempPath, this.filePath);
    } catch (err) {
      if (err && (err.code === "EEXIST" || err.code === "EPERM")) {
        await fsp.rm(this.filePath, { force: true });
        await fsp.rename(tempPath, this.filePath);
        return;
      }
      await fsp.rm(tempPath, { force: true });
      throw err;
    }
  }
}

module.exports = {
  ClassesStore,
  ClassesStoreError,
  createEmptyClassesState,
  normalizeClassesState,
  normalizeClassName,
  CLASS_NAME_MIN,
  CLASS_NAME_MAX,
  DEFAULT_FILE_PATH,
  DEFAULT_MAX_CLASSES,
  DEFAULT_MAX_MEMBERS_PER_CLASS
};
