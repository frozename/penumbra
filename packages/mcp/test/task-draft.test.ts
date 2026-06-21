import { expect, test } from "bun:test";

import { DaemonClient } from "../src/daemon-client.js";
import {
  taskDraftListPendingEscalationsHandler,
  taskDraftListPendingHandler,
} from "../src/tools/task-draft.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function readUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

interface ToolEnvelope {
  content: { type: string; text: string }[];
}

test("task_draft_list_pending forwards to daemon route", async () => {
  let received: unknown = null;
  const daemon = new DaemonClient({
    baseUrl: "http://localhost:1234",
    token: "t",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: FetchInput, init?: FetchInit) => {
    const url = new URL(readUrl(input));
    received = { method: init?.method ?? "GET", path: url.pathname, search: url.search };
    return Promise.resolve(Response.json({ drafts: [{ event_id: "e1" }] }));
  }) as typeof fetch;
  try {
    const out = await taskDraftListPendingHandler(daemon)({
      latest_event_type: "task_draft",
      project_id: "p1",
      limit: 3,
    });
    expect(received).toEqual({
      method: "GET",
      path: "/task-drafts/pending",
      search: "?latest_event_type=task_draft&project_id=p1&limit=3",
    });
    const envelope = out as ToolEnvelope;
    expect(JSON.parse(envelope.content[0]!.text) as unknown).toEqual({
      drafts: [{ event_id: "e1" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task_draft_list_pending rejects missing project_id", async () => {
  const handler = taskDraftListPendingHandler(
    new DaemonClient({
      baseUrl: "http://localhost:1234",
      token: "t",
    }),
  );
  let thrown: unknown = null;
  try {
    await handler({
      latest_event_type: "task_draft",
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
});

test("task_draft_list_pending_escalations forwards to daemon route", async () => {
  let received: unknown = null;
  const daemon = new DaemonClient({
    baseUrl: "http://localhost:1234",
    token: "t",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: FetchInput, init?: FetchInit) => {
    const url = new URL(readUrl(input));
    received = { method: init?.method ?? "GET", path: url.pathname, search: url.search };
    return Promise.resolve(Response.json({ escalations: [{ event_id: "e1" }] }));
  }) as typeof fetch;
  try {
    const out = await taskDraftListPendingEscalationsHandler(daemon)({
      project_id: "p1",
      limit: 3,
    });
    expect(received).toEqual({
      method: "GET",
      path: "/task-drafts/pending-escalations",
      search: "?project_id=p1&limit=3",
    });
    const envelope = out as ToolEnvelope;
    expect(JSON.parse(envelope.content[0]!.text) as unknown).toEqual({
      escalations: [{ event_id: "e1" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
