import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type CodexSafetyOwnership,
  type CodexSafetySetupContext,
  type CodexSafetySource,
  inspectCodexSafetySetup,
  isValidCodexSafetyOwnership,
  prepareCodexSafetySetup,
} from "@src/commands/codex-safety-setup.js";

const GUARD_X = Buffer.from("guard-x\n");
const GUARD_Y = Buffer.from("guard-y\n");

let root = "";
let opts: CodexSafetySetupContext;
let guardPath = "";
let sentinelPath = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codex-safety-state-")));
  opts = { codexDir: join(root, "codex"), packageDir: join(root, "pkg") };
  guardPath = join(opts.codexDir, "penumbra", "hooks", "penumbra-agent-gc-guard.sh");
  sentinelPath = join(opts.codexDir, "penumbra", "allow-agent-gc");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function owned(content: Buffer): CodexSafetyOwnership {
  return { guardPath, sentinelPath, guardHash: sha(content) };
}

function source(content: Buffer): CodexSafetySource {
  return { bytes: content, guardPath, sentinelPath, guardHash: sha(content) };
}

function writeGuard(content: Buffer): void {
  mkdirSync(dirname(guardPath), { recursive: true });
  writeFileSync(guardPath, content);
}

test("isValidCodexSafetyOwnership accepts a record with managed paths and a lowercase 64-hex hash", () => {
  const record: CodexSafetyOwnership = {
    guardPath,
    sentinelPath,
    guardHash: "a".repeat(64),
  };
  expect(isValidCodexSafetyOwnership(record, opts)).toBe(true);
});

test("isValidCodexSafetyOwnership rejects non-object values", () => {
  const values: unknown[] = [null, undefined, 42, true, "string", (): number => 0];
  for (const value of values) {
    expect(isValidCodexSafetyOwnership(value, opts)).toBe(false);
  }
});

test("isValidCodexSafetyOwnership rejects an array carrying matching properties", () => {
  const record = Object.assign([], {
    guardPath,
    sentinelPath,
    guardHash: "a".repeat(64),
  });
  expect(isValidCodexSafetyOwnership(record, opts)).toBe(false);
});

test("isValidCodexSafetyOwnership rejects a guard path outside the managed location", () => {
  const record: CodexSafetyOwnership = {
    guardPath: join(root, "elsewhere.sh"),
    sentinelPath,
    guardHash: "a".repeat(64),
  };
  expect(isValidCodexSafetyOwnership(record, opts)).toBe(false);
});

test("isValidCodexSafetyOwnership rejects a sentinel path outside the managed location", () => {
  const record: CodexSafetyOwnership = {
    guardPath,
    sentinelPath: join(root, "allow-something-else"),
    guardHash: "a".repeat(64),
  };
  expect(isValidCodexSafetyOwnership(record, opts)).toBe(false);
});

test("isValidCodexSafetyOwnership rejects an uppercase hex hash", () => {
  const record: CodexSafetyOwnership = {
    guardPath,
    sentinelPath,
    guardHash: "A".repeat(64),
  };
  expect(isValidCodexSafetyOwnership(record, opts)).toBe(false);
});

test("isValidCodexSafetyOwnership rejects a 63-character hash", () => {
  const record: CodexSafetyOwnership = {
    guardPath,
    sentinelPath,
    guardHash: "a".repeat(63),
  };
  expect(isValidCodexSafetyOwnership(record, opts)).toBe(false);
});

test("isValidCodexSafetyOwnership rejects a 65-character hash", () => {
  const record: CodexSafetyOwnership = {
    guardPath,
    sentinelPath,
    guardHash: "a".repeat(65),
  };
  expect(isValidCodexSafetyOwnership(record, opts)).toBe(false);
});

test("isValidCodexSafetyOwnership rejects a 64-character hash with a non-hex character", () => {
  const record: CodexSafetyOwnership = {
    guardPath,
    sentinelPath,
    guardHash: "g".repeat(64),
  };
  expect(isValidCodexSafetyOwnership(record, opts)).toBe(false);
});

test("isValidCodexSafetyOwnership rejects a numeric hash", () => {
  const record = { guardPath, sentinelPath, guardHash: 1 };
  expect(isValidCodexSafetyOwnership(record, opts)).toBe(false);
});

test("inspectCodexSafetySetup reports absent with no previous record, no guard file and hooks enabled", () => {
  expect(inspectCodexSafetySetup(opts, undefined, undefined, true)).toEqual({
    state: "absent",
    detail: "managed Codex safety guard is absent",
  });
});

test("inspectCodexSafetySetup reports unavailable with no previous record, no guard file and hooks disabled", () => {
  expect(inspectCodexSafetySetup(opts, undefined, undefined, false)).toEqual({
    state: "unavailable",
    detail: "no qualified Codex command safety hook is available",
  });
});

test("inspectCodexSafetySetup reports conflict for an unowned guard file", () => {
  writeGuard(GUARD_X);
  expect(inspectCodexSafetySetup(opts, undefined, undefined, true)).toEqual({
    state: "conflict",
    detail: "unowned managed Codex safety guard exists",
  });
});

test("inspectCodexSafetySetup reports missing when an owned guard file was deleted", () => {
  const previous = owned(GUARD_X);
  expect(inspectCodexSafetySetup(opts, undefined, previous, true)).toEqual({
    state: "absent",
    detail: "managed Codex safety guard is missing",
  });
});

test("inspectCodexSafetySetup reports conflict when the owned guard file was modified", () => {
  const previous = owned(GUARD_X);
  writeGuard(GUARD_Y);
  expect(inspectCodexSafetySetup(opts, undefined, previous, true)).toEqual({
    state: "conflict",
    detail: "managed Codex safety guard was modified",
  });
});

test("inspectCodexSafetySetup reports a pending update when enabled and the packaged source differs", () => {
  const previous = owned(GUARD_X);
  writeGuard(GUARD_X);
  expect(inspectCodexSafetySetup(opts, source(GUARD_Y), previous, true)).toEqual({
    state: "absent",
    detail: "managed Codex safety guard update is pending",
  });
});

test("inspectCodexSafetySetup reports installed for a matching guard file with hooks disabled despite a differing source", () => {
  const previous = owned(GUARD_X);
  writeGuard(GUARD_X);
  expect(inspectCodexSafetySetup(opts, source(GUARD_Y), previous, false)).toEqual({
    state: "installed",
    detail: "managed Codex safety guard matches its recorded hash",
  });
});

test("inspectCodexSafetySetup reports installed for a matching guard file with a matching enabled source", () => {
  const previous = owned(GUARD_X);
  writeGuard(GUARD_X);
  expect(inspectCodexSafetySetup(opts, source(GUARD_X), previous, true)).toEqual({
    state: "installed",
    detail: "managed Codex safety guard matches its recorded hash",
  });
});

test("inspectCodexSafetySetup reports conflict for an ownership record pointing outside without throwing", () => {
  const previous: CodexSafetyOwnership = {
    guardPath: join(root, "outside-guard.sh"),
    sentinelPath,
    guardHash: sha(GUARD_X),
  };
  writeGuard(GUARD_X);
  const result = inspectCodexSafetySetup(opts, source(GUARD_X), previous, true);
  expect(result).toEqual({
    state: "conflict",
    detail: "ownership record contains invalid managed safety paths",
  });
});

test("inspectCodexSafetySetup reports conflict for a symlinked guard path without touching the target", () => {
  const canary = join(root, "canary");
  writeFileSync(canary, "safe\n");
  mkdirSync(dirname(guardPath), { recursive: true });
  symlinkSync(canary, guardPath);
  const result = inspectCodexSafetySetup(opts, undefined, undefined, true);
  expect(result.state).toBe("conflict");
  expect(result.detail).toContain("symlinked managed safety path is not allowed");
  expect(readFileSync(canary, "utf8")).toBe("safe\n");
});

test("prepareCodexSafetySetup rejects an ownership record with a foreign sentinel path", () => {
  const previous: CodexSafetyOwnership = {
    guardPath,
    sentinelPath: join(root, "foreign-sentinel"),
    guardHash: sha(GUARD_X),
  };
  expect(() => {
    prepareCodexSafetySetup(opts, source(GUARD_X), previous, true);
  }).toThrow(/ownership record contains invalid managed safety paths/);
});

test("prepareCodexSafetySetup rejects an enabled setup with a valid previous but no packaged source", () => {
  const previous = owned(GUARD_X);
  expect(() => {
    prepareCodexSafetySetup(opts, undefined, previous, true);
  }).toThrow(/packaged safety guard is absent/);
});

test("prepareCodexSafetySetup rejects an unowned guard file and names its path", () => {
  writeGuard(GUARD_X);
  expect(() => {
    prepareCodexSafetySetup(opts, source(GUARD_X), undefined, true);
  }).toThrow(`unowned managed safety guard exists: ${guardPath}`);
});

test("prepareCodexSafetySetup rejects a modified owned guard file", () => {
  const previous = owned(GUARD_X);
  writeGuard(GUARD_Y);
  expect(() => {
    prepareCodexSafetySetup(opts, source(GUARD_X), previous, true);
  }).toThrow(/managed safety guard was modified/);
});

test("prepareCodexSafetySetup with hooks disabled returns prior bytes and no ownership", () => {
  const previous = owned(GUARD_X);
  writeGuard(GUARD_X);
  const result = prepareCodexSafetySetup(opts, source(GUARD_Y), previous, false);
  expect(result.next).toBe(null);
  expect(result.current).toEqual(GUARD_X);
  expect(Object.hasOwn(result, "ownership")).toBe(false);
});

test("prepareCodexSafetySetup with hooks enabled returns the source bytes and derived ownership", () => {
  const result = prepareCodexSafetySetup(opts, source(GUARD_X), undefined, true);
  expect(result).toEqual({
    current: null,
    next: GUARD_X,
    ownership: { guardPath, guardHash: sha(GUARD_X), sentinelPath },
  });
});
