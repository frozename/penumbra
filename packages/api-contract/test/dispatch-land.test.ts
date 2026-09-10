import { expect, test } from "bun:test";

import {
  DispatchLandAcceptedSchema,
  DispatchLandRequestSchema,
  DispatchLandTaskSchema,
} from "../src/index.js";

test("DispatchLandRequestSchema defaults mode to squash", () => {
  const parsed = DispatchLandRequestSchema.safeParse({ handoff_id: "h1" });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.mode).toBe("squash");
  }
});

test("DispatchLandRequestSchema defaults booleans", () => {
  const parsed = DispatchLandRequestSchema.safeParse({ handoff_id: "h1" });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.delete_branch).toBe(true);
    expect(parsed.data.force).toBe(false);
    expect(parsed.data.reject_if_held).toBe(false);
  }
});

test("DispatchLandRequestSchema accepts mode gh", () => {
  expect(DispatchLandRequestSchema.safeParse({ handoff_id: "h1", mode: "gh" }).success).toBe(true);
});

test("DispatchLandRequestSchema rejects unknown mode", () => {
  expect(DispatchLandRequestSchema.safeParse({ handoff_id: "h1", mode: "rebase" }).success).toBe(
    false,
  );
});

test("DispatchLandRequestSchema requires handoff_id", () => {
  expect(DispatchLandRequestSchema.safeParse({}).success).toBe(false);
});

test("DispatchLandRequestSchema allows defaulted fields to be omitted (input type)", () => {
  const minimal = { handoff_id: "h1" };
  const parsed = DispatchLandRequestSchema.safeParse(minimal);
  expect(parsed.success).toBe(true);
});

test("DispatchLandAcceptedSchema is loose with ok:true, task_id, status enum, no handoff_id", () => {
  const parsed = DispatchLandAcceptedSchema.safeParse({
    ok: true,
    task_id: "t1",
    status: "queued",
    extra: "allowed",
  });
  expect(parsed.success).toBe(true);
});

test("DispatchLandAcceptedSchema rejects ok:false", () => {
  expect(
    DispatchLandAcceptedSchema.safeParse({ ok: false, task_id: "t1", status: "queued" }).success,
  ).toBe(false);
});

test("DispatchLandAcceptedSchema rejects missing task_id", () => {
  expect(DispatchLandAcceptedSchema.safeParse({ ok: true, status: "queued" }).success).toBe(false);
});

test("DispatchLandAcceptedSchema rejects unknown status", () => {
  expect(
    DispatchLandAcceptedSchema.safeParse({ ok: true, task_id: "t1", status: "pending" }).success,
  ).toBe(false);
});

test("DispatchLandAcceptedSchema accepts running status (not just queued)", () => {
  expect(
    DispatchLandAcceptedSchema.safeParse({ ok: true, task_id: "t1", status: "running" }).success,
  ).toBe(true);
});

test("DispatchLandTaskSchema has all eight fields with nullable timestamps/result/error", () => {
  const task = {
    task_id: "t1",
    handoff_id: "h1",
    status: "queued",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    result: null,
    error: null,
  };
  expect(DispatchLandTaskSchema.safeParse(task).success).toBe(true);
});

test("DispatchLandTaskSchema rejects missing error field", () => {
  const task = {
    task_id: "t1",
    handoff_id: "h1",
    status: "done",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:01.000Z",
    finished_at: "2026-01-01T00:00:02.000Z",
    result: null,
  };
  expect(DispatchLandTaskSchema.safeParse(task).success).toBe(false);
});

test("DispatchLandTaskSchema is loose (accepts extra fields)", () => {
  const task = {
    task_id: "t1",
    handoff_id: "h1",
    status: "failed",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    result: null,
    error: { code: "git_failed" },
    extra: "allowed",
  };
  expect(DispatchLandTaskSchema.safeParse(task).success).toBe(true);
});
