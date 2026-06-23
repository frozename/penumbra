import { DispatchEventKindSchema } from "@penumbra/api-contract";
import { applySchema, buildServices, loadSqliteVec, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  dispatchEventsGetRoute,
  dispatchEventsPostRoute,
} from "../../src/routes/dispatch-events.js";
import { createDaemonFetchHandler } from "../../src/serve.js";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/dispatch-events-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function startTestDaemon(): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  url: string;
} {
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

  test("POST records acp.session.reuse + agent.heartbeat (regression: whitelist drift)", async () => {
    // Both are worker-emitted kinds that were absent from the route's
    // hand-maintained accepted-kind list, so every batch carrying them
    // 400-rejected and the events were never recorded. With acp.session.reuse
    // dropped, fleet_latency's acp_session_reuse_rate was structurally pinned at
    // 0 even when warm-pool reuse actually fired.
    const req = new Request("http://x/dispatch/events", {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            handoff_id: "h-reuse",
            worker_id: "w",
            source: "worker",
            kind: "acp.session.reuse",
            ts: "2026-05-01T00:00:00.000Z",
            meta: { pool_key: "codex-acp-fast /repo", framework_overhead_ms: 120 },
          },
          {
            handoff_id: "h-reuse",
            worker_id: "w",
            source: "worker",
            kind: "agent.heartbeat",
            ts: "2026-05-01T00:00:01.000Z",
          },
        ],
      }),
    });

    const res = await dispatchEventsPostRoute(req, services);
    expect(res.status).toBe(200);
    expect(services.dispatchEventLog.listByHandoff("h-reuse").map((event) => event.kind)).toEqual([
      "acp.session.reuse",
      "agent.heartbeat",
    ]);
  });

  test("POST accepts every DispatchEventKind (accepted-kind list can't drift)", async () => {
    // The route derives its accepted kinds from DispatchEventKindSchema, so a
    // kind added to the api-contract enum can never again be silently dropped at
    // ingestion. Posts one event per enum value (batched under the 50 cap).
    const kinds = DispatchEventKindSchema.options;
    const events = kinds.map((kind, i) => ({
      handoff_id: "h-all",
      worker_id: "w",
      source: "worker" as const,
      kind,
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    for (let i = 0; i < events.length; i += 50) {
      const res = await dispatchEventsPostRoute(
        new Request("http://x/dispatch/events", {
          method: "POST",
          body: JSON.stringify({ events: events.slice(i, i + 50) }),
        }),
        services,
      );
      expect(res.status).toBe(200);
    }
    expect(services.dispatchEventLog.listByHandoff("h-all")).toHaveLength(kinds.length);
  });

  test("POST accepts agent thought event kinds and GET returns them", async () => {
    const { fetch, services, token, url } = startTestDaemon();
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
    const json = (await get.json()) as { events: { kind: string }[] };
    expect(json.events.map((e) => e.kind)).toEqual([
      "agent.thought",
      "agent.thought.overflow",
      "agent.thought.digest",
      "agent.thought.signal",
    ]);
    expect(services.dispatchEventLog.listByHandoff(handoffId)).toHaveLength(4);
  });

  test("POST accepts shell event kinds and GET returns them", async () => {
    const { fetch, services, token, url } = startTestDaemon();
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
    const json = (await get.json()) as { events: { kind: string }[] };
    expect(json.events.map((e) => e.kind)).toEqual([
      "shell.session.open",
      "shell.run",
      "shell.session.close",
    ]);
    expect(services.dispatchEventLog.listByHandoff(handoffId)).toHaveLength(3);
  });

  test("POST accepts worker recovery event kinds and GET returns them", async () => {
    const { fetch, services, token, url } = startTestDaemon();
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
    const json = (await get.json()) as { events: { kind: string; meta: unknown }[] };
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

    const res = dispatchEventsGetRoute(
      new Request("http://x/dispatch/events?handoff_id=h-1"),
      services,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { handoff_id: string; kind: string; meta: unknown }[];
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
    expect(dispatchEventsGetRoute(new Request("http://x/dispatch/events"), services).status).toBe(
      400,
    );
    const res = dispatchEventsGetRoute(
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
