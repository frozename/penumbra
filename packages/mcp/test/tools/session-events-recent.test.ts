import { expect, mock, test } from "bun:test";
import { z } from "zod";

import type { DaemonClient } from "@src/daemon-client.js";
import {
  sessionEventsRecentHandler,
  SessionEventsRecentInputShape,
} from "@src/tools/session-events-recent.js";

import { connectInMemory, fakeDaemon, installFetchMock, requestUrl } from "../helpers.js";

type SessionEventsRecentFn = DaemonClient["sessionEventsRecent"];

test("SessionEventsRecentInputShape accepts optional filters", () => {
  const schema = z.object(SessionEventsRecentInputShape).strict();
  expect(schema.parse({})).toEqual({});
  expect(schema.parse({ session_id: "s-1", kind_prefix: "continuity.", limit: 10 })).toEqual({
    session_id: "s-1",
    kind_prefix: "continuity.",
    limit: 10,
  });
  expect(() => schema.parse({ limit: 0 })).toThrow();
});

test("wraps GET /session-events and validates against SessionEventsListResponseSchema", async () => {
  const response = {
    events: [
      {
        session_id: "s-1",
        related_session_id: null,
        project_id: "proj",
        cwd: "/repo",
        transcript_path: null,
        ref_path: null,
        kind: "session.start",
        ts: "2026-05-01T00:00:00.000Z",
        meta: null,
      },
    ],
  };
  const sessionEventsRecent: SessionEventsRecentFn = mock(() => Promise.resolve(response));

  const result = await sessionEventsRecentHandler(fakeDaemon({ sessionEventsRecent }))({
    session_id: "s-1",
  });

  expect(sessionEventsRecent).toHaveBeenCalledWith({ session_id: "s-1" });
  const block = result.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text)).toEqual(response);
});

test("validates null session_id rows from GET /session-events", async () => {
  const response = {
    events: [
      {
        session_id: null,
        related_session_id: null,
        project_id: "proj",
        cwd: "/repo",
        transcript_path: null,
        ref_path: null,
        kind: "session.stop",
        ts: "2026-05-01T00:00:00.000Z",
        meta: null,
      },
    ],
  };
  const sessionEventsRecent: SessionEventsRecentFn = mock(() => Promise.resolve(response));

  const result = await sessionEventsRecentHandler(fakeDaemon({ sessionEventsRecent }))({});

  const block = result.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text)).toEqual(response);
});

test("session_events is registered and forwards through DaemonClient to GET /session-events", async () => {
  let receivedPath: string | undefined;
  let receivedSessionId: string | null = null;
  let receivedKindPrefix: string | null = null;
  let receivedAuth: string | null = null;
  const events = {
    events: [
      {
        session_id: "s space",
        related_session_id: null,
        project_id: null,
        cwd: null,
        transcript_path: null,
        ref_path: null,
        kind: "continuity.boot_pickup",
        ts: "2026-05-01T00:00:00.000Z",
        meta: { ok: true },
      },
    ],
  };
  const { daemon, restore } = installFetchMock((input, init): Promise<Response> => {
    const url = new URL(requestUrl(input));
    receivedPath = url.pathname;
    receivedSessionId = url.searchParams.get("session_id");
    receivedKindPrefix = url.searchParams.get("kind_prefix");
    receivedAuth = init?.headers ? new Headers(init.headers).get("authorization") : null;
    return Promise.resolve(Response.json(events));
  });
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  const originalInvocationLogEnabled = process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = "0";

  try {
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: "session_events",
      arguments: { session_id: "s space", kind_prefix: "continuity." },
    });
    const content = (out as unknown as { content: { type: string; text: string }[] }).content;
    const firstBlock = content[0];
    if (firstBlock === undefined) throw new Error("expected content[0]");

    expect(JSON.parse(firstBlock.text)).toEqual(events);
    expect(receivedPath).toBe("/session-events");
    expect(receivedSessionId).toBe("s space");
    expect(receivedKindPrefix).toBe("continuity.");
    expect(receivedAuth).toBe("Bearer t");
  } finally {
    await client?.close();
    if (originalInvocationLogEnabled === undefined) {
      delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    } else {
      process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = originalInvocationLogEnabled;
    }
    restore();
  }
});
