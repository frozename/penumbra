import { expect, test } from "bun:test";

import { T0EventInputSchema } from "../../src/schemas/event.js";
import { assertSafeProjectId, SafeProjectIdSchema } from "../../src/schemas/project-id.js";

// ---------------------------------------------------------------------------
// SafeProjectIdSchema — valid IDs
// ---------------------------------------------------------------------------

test("SafeProjectIdSchema accepts git-style id at repo root", () => {
  expect(() => SafeProjectIdSchema.parse("abcdef0123456789:.")).not.toThrow();
});

test("SafeProjectIdSchema accepts git-style id with subdirectory", () => {
  expect(() => SafeProjectIdSchema.parse("abcdef0123456789:packages/x")).not.toThrow();
});

test("SafeProjectIdSchema accepts marker-style UUID", () => {
  expect(() => SafeProjectIdSchema.parse("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
});

test("SafeProjectIdSchema accepts declared-style identifier", () => {
  expect(() => SafeProjectIdSchema.parse("declared-xyz")).not.toThrow();
  expect(() => SafeProjectIdSchema.parse("proj-e2e")).not.toThrow();
  expect(() => SafeProjectIdSchema.parse("proj-ctx")).not.toThrow();
});

// ---------------------------------------------------------------------------
// SafeProjectIdSchema — path traversal rejections
// ---------------------------------------------------------------------------

test('SafeProjectIdSchema rejects "../etc" traversal', () => {
  expect(() => SafeProjectIdSchema.parse("../etc")).toThrow();
});

test('SafeProjectIdSchema rejects "../../etc/cron.d" traversal', () => {
  expect(() => SafeProjectIdSchema.parse("../../etc/cron.d")).toThrow();
});

test("SafeProjectIdSchema rejects absolute path", () => {
  expect(() => SafeProjectIdSchema.parse("/etc/passwd")).toThrow();
});

test("SafeProjectIdSchema rejects backslash", () => {
  expect(() => SafeProjectIdSchema.parse("..\\evil")).toThrow();
});

test("SafeProjectIdSchema rejects NUL byte", () => {
  expect(() => SafeProjectIdSchema.parse("foo\x00bar")).toThrow();
});

test("SafeProjectIdSchema rejects empty string", () => {
  expect(() => SafeProjectIdSchema.parse("")).toThrow();
});

test("SafeProjectIdSchema rejects __null__ sentinel", () => {
  expect(() => SafeProjectIdSchema.parse("__null__")).toThrow();
});

test("SafeProjectIdSchema rejects id exceeding 200 chars", () => {
  expect(() => SafeProjectIdSchema.parse("a".repeat(201))).toThrow();
});

// ---------------------------------------------------------------------------
// T0EventInputSchema — project_id field enforced
// ---------------------------------------------------------------------------

const baseEvent = {
  ts: new Date().toISOString(),
  source: "mcp" as const,
  event_type: "agent-prompt" as const,
  lane: "local" as const,
  user_id: "u",
  machine_id: "m",
  payload_json: {},
};

test("T0EventInputSchema accepts null project_id", () => {
  expect(() => T0EventInputSchema.parse({ ...baseEvent, project_id: null })).not.toThrow();
});

test("T0EventInputSchema accepts safe project_id", () => {
  expect(() => T0EventInputSchema.parse({ ...baseEvent, project_id: "proj-e2e" })).not.toThrow();
});

test('T0EventInputSchema rejects traversal project_id "../etc"', () => {
  expect(() => T0EventInputSchema.parse({ ...baseEvent, project_id: "../etc" })).toThrow();
});

test('T0EventInputSchema rejects traversal project_id "../../etc/cron.d"', () => {
  expect(() =>
    T0EventInputSchema.parse({ ...baseEvent, project_id: "../../etc/cron.d" }),
  ).toThrow();
});

// ---------------------------------------------------------------------------
// assertSafeProjectId — defense in depth
// ---------------------------------------------------------------------------

test("assertSafeProjectId passes on safe ids", () => {
  expect(() => {
    assertSafeProjectId("proj-ctx");
  }).not.toThrow();
  expect(() => {
    assertSafeProjectId("abcdef0123456789:.");
  }).not.toThrow();
  expect(() => {
    assertSafeProjectId("abcdef0123456789:packages/core");
  }).not.toThrow();
});

test("assertSafeProjectId throws TypeError on traversal", () => {
  expect(() => {
    assertSafeProjectId("../evil");
  }).toThrow(TypeError);
  expect(() => {
    assertSafeProjectId("../../etc/cron.d");
  }).toThrow(TypeError);
});

test("assertSafeProjectId throws TypeError on absolute path", () => {
  expect(() => {
    assertSafeProjectId("/etc/passwd");
  }).toThrow(TypeError);
});

test("assertSafeProjectId throws TypeError on backslash", () => {
  expect(() => {
    assertSafeProjectId("..\\windows\\evil");
  }).toThrow(TypeError);
});
