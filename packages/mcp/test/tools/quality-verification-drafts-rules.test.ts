import type { TextContentEnvelope } from "@novaproto/mcp-shared";

import { expect, mock, test } from "bun:test";
import { ZodError } from "zod";

import type { DaemonClient } from "@src/daemon-client.js";
import { memoryVerificationEventsHandler } from "@src/tools/memory-verification-events.js";
import { qualityStatusHandler } from "@src/tools/quality-status.js";
import { sessionNoteDraftsHandler } from "@src/tools/session-note-drafts.js";

import { fakeDaemon } from "../helpers.js";

type QualityFn = DaemonClient["qualityStatus"];
type EventsFn = DaemonClient["memoryVerificationEvents"];
type DraftsFn = DaemonClient["sessionNoteDrafts"];
type DraftsBody = Awaited<ReturnType<DraftsFn>>;

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject but it resolved");
}

function firstZodIssue(err: unknown): { code: string; path: readonly PropertyKey[] } {
  expect(err).toBeInstanceOf(ZodError);
  const issue = (err as ZodError).issues[0];
  if (issue === undefined) throw new Error("expected zod to report at least one issue");
  return { code: issue.code, path: issue.path };
}

function newQuality(): QualityFn {
  return mock(() => Promise.resolve({}));
}

function newEvents(): EventsFn {
  return mock(() => Promise.resolve({ events: [] }));
}

function draftsReturning(body: unknown): DraftsFn {
  return mock(() => Promise.resolve(body as DraftsBody));
}

function envelopeJson(envelope: TextContentEnvelope): unknown {
  const block = envelope.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  return JSON.parse(block.text);
}

test("qualityStatusHandler rejects an unknown key with unrecognized_keys", async () => {
  const qualityStatus = newQuality();
  const handler = qualityStatusHandler(fakeDaemon({ qualityStatus }));

  const err = await catchError(() => handler({ window_hours: 24, bogus: 1 }));

  const issue = firstZodIssue(err);
  expect(issue.code).toBe("unrecognized_keys");
  expect(qualityStatus).toHaveBeenCalledTimes(0);
});

test("qualityStatusHandler rejects a string window_hours as invalid_type without coercing", async () => {
  const qualityStatus = newQuality();
  const handler = qualityStatusHandler(fakeDaemon({ qualityStatus }));

  const err = await catchError(() => handler({ window_hours: "24" }));

  const issue = firstZodIssue(err);
  expect(issue.code).toBe("invalid_type");
  expect(issue.path).toEqual(["window_hours"]);
  expect(qualityStatus).toHaveBeenCalledTimes(0);
});

test("memoryVerificationEventsHandler rejects an empty memory_id with too_small", async () => {
  const memoryVerificationEvents = newEvents();
  const handler = memoryVerificationEventsHandler(fakeDaemon({ memoryVerificationEvents }));

  const err = await catchError(() => handler({ memory_id: "" }));

  const issue = firstZodIssue(err);
  expect(issue.code).toBe("too_small");
  expect(issue.path).toEqual(["memory_id"]);
  expect(memoryVerificationEvents).toHaveBeenCalledTimes(0);
});

test("memoryVerificationEventsHandler rejects input missing memory_id at path memory_id", async () => {
  const memoryVerificationEvents = newEvents();
  const handler = memoryVerificationEventsHandler(fakeDaemon({ memoryVerificationEvents }));

  const err = await catchError(() => handler({ limit: 5 }));

  const issue = firstZodIssue(err);
  expect(issue.path).toEqual(["memory_id"]);
  expect(memoryVerificationEvents).toHaveBeenCalledTimes(0);
});

test("memoryVerificationEventsHandler rejects a non-integer limit at path limit", async () => {
  const memoryVerificationEvents = newEvents();
  const handler = memoryVerificationEventsHandler(fakeDaemon({ memoryVerificationEvents }));

  const err = await catchError(() => handler({ memory_id: "m1", limit: 1.5 }));

  const issue = firstZodIssue(err);
  expect(issue.path).toEqual(["limit"]);
  expect(memoryVerificationEvents).toHaveBeenCalledTimes(0);
});

test("memoryVerificationEventsHandler rejects an unknown key with unrecognized_keys", async () => {
  const memoryVerificationEvents = newEvents();
  const handler = memoryVerificationEventsHandler(fakeDaemon({ memoryVerificationEvents }));

  const err = await catchError(() => handler({ memory_id: "m1", extra: true }));

  const issue = firstZodIssue(err);
  expect(issue.code).toBe("unrecognized_keys");
  expect(memoryVerificationEvents).toHaveBeenCalledTimes(0);
});

test("sessionNoteDraftsHandler forwards {} for undefined input", async () => {
  const sessionNoteDrafts = mock<DraftsFn>(() => Promise.resolve({ drafts: [] }));
  const handler = sessionNoteDraftsHandler(fakeDaemon({ sessionNoteDrafts }));

  await handler(undefined);

  expect(sessionNoteDrafts).toHaveBeenCalledTimes(1);
  expect(sessionNoteDrafts).toHaveBeenCalledWith({});
});

test("sessionNoteDraftsHandler forwards {} for null input", async () => {
  const sessionNoteDrafts = mock<DraftsFn>(() => Promise.resolve({ drafts: [] }));
  const handler = sessionNoteDraftsHandler(fakeDaemon({ sessionNoteDrafts }));

  await handler(null);

  expect(sessionNoteDrafts).toHaveBeenCalledTimes(1);
  expect(sessionNoteDrafts).toHaveBeenCalledWith({});
});

test("sessionNoteDraftsHandler forwards the coerced numeric limit, not the raw string", async () => {
  const sessionNoteDrafts = mock<DraftsFn>(() => Promise.resolve({ drafts: [] }));
  const handler = sessionNoteDraftsHandler(fakeDaemon({ sessionNoteDrafts }));

  await handler({ limit: "25" });

  expect(sessionNoteDrafts).toHaveBeenCalledTimes(1);
  expect(sessionNoteDrafts).toHaveBeenCalledWith({ limit: 25 });
});

test("sessionNoteDraftsHandler strips unknown top-level keys from the daemon response", async () => {
  const sessionNoteDrafts = draftsReturning({ drafts: [], extra: 1 });
  const handler = sessionNoteDraftsHandler(fakeDaemon({ sessionNoteDrafts }));

  const out = await handler({});

  const parsed = envelopeJson(out);
  expect(parsed).toEqual({ drafts: [] });
  expect(parsed).not.toHaveProperty("extra");
});

test("sessionNoteDraftsHandler returns an invalid_response error envelope for a malformed body", async () => {
  const sessionNoteDrafts = draftsReturning({ drafts: "nope" });
  const handler = sessionNoteDraftsHandler(fakeDaemon({ sessionNoteDrafts }));

  const out = await handler({});

  expect(out.isError).toBe(true);
  const parsed = envelopeJson(out) as { error: { code: string; message: string } };
  expect(parsed.error.code).toBe("invalid_response");
  expect(parsed.error.message.startsWith("session_note_drafts: ")).toBe(true);
});
