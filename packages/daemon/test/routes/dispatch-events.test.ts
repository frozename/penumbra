import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema, buildServices, loadSqliteVec, type Services } from "@penumbra/core";
import { createDaemonFetchHandler } from "../../src/serve.js";
import {
  dispatchEventsGetRoute,
  dispatchEventsPostRoute,
} from "../../src/routes/dispatch-events.js";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/dispatch-events-test",
    db,
    embedder: null as any,
  });
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function startTestDaemon(): Promise<{
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  url: string;
}> {
  const services = tempServices();
  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token });
  return {
    fetch: (input, init) => handler(new Request(input, init)),
    services,
    token,
    url: "http://x",
  };
}

describe("dispatch events routes", () => {
  let services: Services;

  beforeEach(() => {
    services = tempServices();
  });

  test("POST accepts a batch and records events", async () => {
    const req = new Request("http://x/dispatch/events", {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            handoff_id: "h-1",
            worker_id: "w-1",
            source: "worker",
            kind: "dispatch.start",
            ts: "2026-05-01T00:00:00.000Z",
          },
          {
            handoff_id: "h-1",
            worker_id: "w-1",
            source: "worker",
            kind: "dispatch.end",
            ts: "2026-05-01T00:00:01.000Z",
          },
        ],
      }),
    });

    const res = await dispatchEventsPostRoute(req, services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 2 });
    expect(services.dispatchEventLog.listByHandoff("h-1")).toHaveLength(2);
  });

  test("POST accepts ACP adapter lifecycle events", async () => {
    const req = new Request("http://x/dispatch/events", {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            handoff_id: "h-acp",
            worker_id: "w-1",
            source: "worker",
            kind: "acp.session.start",
            ts: "2026-05-01T00:00:00.000Z",
          },
          {
            handoff_id: "h-acp",
            worker_id: "w-1",
            source: "worker",
            kind: "acp.session.end",
            ts: "2026-05-01T00:00:01.000Z",
          },
        ],
      }),
    });

    const res = await dispatchEventsPostRoute(req, services);
    expect(res.status).toBe(200);
    expect(services.dispatchEventLog.listByHandoff("h-acp").map((event) => event.kind)).toEqual([
      "acp.session.start",
      "acp.session.end",
    ]);
  });

  test("POST accepts agent thought event kinds and GET returns them", async () => {
    const { fetch, services, token, url } = await startTestDaemon();
    const handoffId = "h-thoughts-1";
    const body = {
      events: [
        {
          handoff_id: handoffId,
          worker_id: "w",
          source: "worker",
          kind: "agent.thought",
          ts: "2026-05-02T10:00:00.000Z",
          meta: {
            sequence_n: 0,
            adapter: "stdio-acp",
            agent_name: "claude-acp-sonnet",
            text: "thinking",
            token_count: 5,
          },
        },
        {
          handoff_id: handoffId,
          worker_id: "w",
          source: "worker",
          kind: "agent.thought.overflow",
          ts: "2026-05-02T10:00:01.000Z",
          meta: { sequence_n: 0, bytes_dropped: 4096 },
        },
        {
          handoff_id: handoffId,
          worker_id: null,
          source: "worker",
          kind: "agent.thought.digest",
          ts: "2026-05-02T10:00:02.000Z",
          meta: { digester_agent: "local-gemma26", digest_text: "summary" },
        },
        {
          handoff_id: handoffId,
          worker_id: null,
          source: "worker",
          kind: "agent.thought.signal",
          ts: "2026-05-02T10:00:03.000Z",
          meta: {
            signal_name: "uncertainty",
            evidence_text: "doubt",
            extractor_agent: "local-gemma26",
          },
        },
      ],
    };

    const post = await fetch(`${url}/dispatch/events`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    expect(post.status).toBe(200);

    const get = await fetch(`${url}/dispatch/events?handoff_id=${encodeURIComponent(handoffId)}`, {
      headers: authHeaders(token),
    });
    expect(get.status).toBe(200);
    const json = (await get.json()) as { events: Array<{ kind: string }> };
    expect(json.events.map((e) => e.kind)).toEqual([
      "agent.thought",
      "agent.thought.overflow",
      "agent.thought.digest",
      "agent.thought.signal",
    ]);
    expect(services.dispatchEventLog.listByHandoff(handoffId)).toHaveLength(4);
  });

  test("POST accepts shell event kinds and GET returns them", async () => {
    const { fetch, services, token, url } = await startTestDaemon();
    const handoffId = "h-shell-1";
    const body = {
      events: [
        {
          handoff_id: handoffId,
          worker_id: "w",
          source: "daemon",
          kind: "shell.session.open",
          ts: "2026-05-02T10:00:00.000Z",
          meta: { session_id: "sess-1", cwd: "/tmp", pty: false },
        },
        {
          handoff_id: handoffId,
          worker_id: "w",
          source: "daemon",
          kind: "shell.run",
          ts: "2026-05-02T10:00:01.000Z",
          meta: {
            session_id: "sess-1",
            command: "pwd",
            exit_code: 0,
            duration_ms: 12,
            truncated: false,
          },
        },
        {
          handoff_id: handoffId,
          worker_id: "w",
          source: "daemon",
          kind: "shell.session.close",
          ts: "2026-05-02T10:00:02.000Z",
          meta: { session_id: "sess-1", reason: "explicit" },
        },
      ],
    };

    const post = await fetch(`${url}/dispatch/events`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    expect(post.status).toBe(200);

    const get = await fetch(`${url}/dispatch/events?handoff_id=${encodeURIComponent(handoffId)}`, {
      headers: authHeaders(token),
    });
    expect(get.status).toBe(200);
    const json = (await get.json()) as { events: Array<{ kind: string }> };
    expect(json.events.map((e) => e.kind)).toEqual([
      "shell.session.open",
      "shell.run",
      "shell.session.close",
    ]);
    expect(services.dispatchEventLog.listByHandoff(handoffId)).toHaveLength(3);
  });

  test("POST accepts worker recovery event kinds and GET returns them", async () => {
    const { fetch, services, token, url } = await startTestDaemon();
    const handoffId = "h-recovery-1";
    const body = {
      events: [
        {
          handoff_id: handoffId,
          worker_id: "w-new",
          source: "daemon",
          kind: "worker.recovery.requeued",
          ts: "2026-05-02T10:00:00.000Z",
          meta: {
            attempt: 2,
            max_attempts: 3,
            from_worker_id: "w-dead",
            handoff_id: handoffId,
          },
        },
        {
          handoff_id: handoffId,
          worker_id: null,
          source: "daemon",
          kind: "worker.recovery.exhausted",
          ts: "2026-05-02T10:00:01.000Z",
          meta: {
            attempt: 3,
            max_attempts: 3,
            from_worker_id: "w-dead",
            handoff_id: handoffId,
          },
        },
      ],
    };

    const post = await fetch(`${url}/dispatch/events`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    expect(post.status).toBe(200);

    const get = await fetch(`${url}/dispatch/events?handoff_id=${encodeURIComponent(handoffId)}`, {
      headers: authHeaders(token),
    });
    expect(get.status).toBe(200);
    const json = (await get.json()) as { events: Array<{ kind: string; meta: any }> };
    expect(json.events.map((e) => e.kind)).toEqual([
      "worker.recovery.requeued",
      "worker.recovery.exhausted",
    ]);
    expect(json.events[0].meta).toEqual(body.events[0].meta);
    expect(json.events[1].meta).toEqual(body.events[1].meta);
    expect(services.dispatchEventLog.listByHandoff(handoffId)).toHaveLength(2);
  });

  test("POST rejects malformed payloads and unknown event kinds", async () => {
    const malformed = await dispatchEventsPostRoute(
      new Request("http://x/dispatch/events", { method: "POST", body: '{"events":"nope"}' }),
      services,
    );
    expect(malformed.status).toBe(400);

    const unknownKind = await dispatchEventsPostRoute(
      new Request("http://x/dispatch/events", {
        method: "POST",
        body: JSON.stringify({
          events: [{ handoff_id: "h-1", source: "worker", kind: "bogus.kind", ts: "t" }],
        }),
      }),
      services,
    );
    expect(unknownKind.status).toBe(400);
    expect(services.dispatchEventLog.listByHandoff("h-1")).toHaveLength(0);
  });

  test("POST caps batches at 50 events", async () => {
    const events = Array.from({ length: 51 }, (_, i) => ({
      handoff_id: "h-1",
      source: "worker",
      kind: "proc.spawn",
      ts: `2026-05-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    }));

    const res = await dispatchEventsPostRoute(
      new Request("http://x/dispatch/events", { method: "POST", body: JSON.stringify({ events }) }),
      services,
    );
    expect(res.status).toBe(400);
  });

  test("GET returns requested handoff timeline ordered by timestamp", async () => {
    services.dispatchEventLog.recordBatch([
      {
        handoff_id: "h-1",
        worker_id: "w-1",
        source: "worker",
        kind: "dispatch.end",
        ts: "2026-05-01T00:00:02.000Z",
      },
      {
        handoff_id: "h-2",
        worker_id: "w-1",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-05-01T00:00:00.500Z",
      },
      {
        handoff_id: "h-1",
        worker_id: "w-1",
        source: "worker",
        kind: "proc.spawn",
        ts: "2026-05-01T00:00:01.000Z",
        meta: { pid: 123 },
      },
      {
        handoff_id: "h-1",
        worker_id: "w-1",
        source: "worker",
        kind: "dispatch.start",
        ts: "2026-05-01T00:00:00.000Z",
      },
    ]);

    const res = await dispatchEventsGetRoute(
      new Request("http://x/dispatch/events?handoff_id=h-1"),
      services,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ handoff_id: string; kind: string; meta: unknown }>;
    };
    expect(body.events.map((e) => e.kind)).toEqual([
      "dispatch.start",
      "proc.spawn",
      "dispatch.end",
    ]);
    expect(body.events.every((e) => e.handoff_id === "h-1")).toBe(true);
    expect(body.events[1].meta).toEqual({ pid: 123 });
  });

  test("GET returns 400 without handoff_id and empty list for unknown handoff", async () => {
    expect(
      (await dispatchEventsGetRoute(new Request("http://x/dispatch/events"), services)).status,
    ).toBe(400);
    const res = await dispatchEventsGetRoute(
      new Request("http://x/dispatch/events?handoff_id=missing"),
      services,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });

  test("serve.ts wires authenticated GET and POST /dispatch/events", async () => {
    const handler = createDaemonFetchHandler({ services, token: "tok" });
    const post = await handler(
      new Request("http://x/dispatch/events", {
        method: "POST",
        headers: { authorization: "Bearer tok" },
        body: JSON.stringify({
          events: [
            {
              handoff_id: "h-9",
              source: "worker",
              kind: "dispatch.start",
              ts: "2026-05-01T00:00:00.000Z",
            },
          ],
        }),
      }),
    );
    expect(post.status).toBe(200);

    const get = await handler(
      new Request("http://x/dispatch/events?handoff_id=h-9", {
        headers: { authorization: "Bearer tok" },
      }),
    );
    expect(get.status).toBe(200);
    expect(((await get.json()) as { events: unknown[] }).events).toHaveLength(1);
  });
});
