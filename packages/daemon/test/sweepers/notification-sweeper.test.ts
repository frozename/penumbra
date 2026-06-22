import { loadSqliteVec, NotificationOutboxWriter } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import {
  runNotificationDelivery,
  runNotificationDiscovery,
  runNotificationSweep,
} from "@penumbra/daemon/sweepers/notification-sweeper";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

function setup(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

function writeDraftEvent(
  db: Database,
  opts: {
    event_id: string;
    project_id?: string | null;
    event_type?: string;
    payload_json?: string;
    ts?: string;
  },
): void {
  const ts = opts.ts ?? new Date(Date.now() - 10_000).toISOString();
  db.prepare(
    `INSERT INTO t0_events (event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id, payload_json, payload_summary, origin)
     VALUES (?, ?, ?, 'daemon', 'test', ?, 'test', 'test', NULL, ?, 'system', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 'test event', 'unknown')`,
  ).run(
    opts.event_id,
    ts,
    ts,
    opts.project_id ?? null,
    opts.event_type ?? "task_draft",
    opts.payload_json ?? JSON.stringify({ draft_id: opts.event_id, prompt: "test prompt" }),
  );
}

function insertAgent(db: Database, agentId: string, projectId: string | null = null): void {
  db.prepare(
    `INSERT INTO long_lived_agents (id, display_name, project_id, schedule_cron, standing_brief, mcp_allowlist_json, working_memory_json, created_at, updated_at)
     VALUES (?, ?, ?, '*/15 * * * *', 'test', '[]', '{}', ?, ?)`,
  ).run(agentId, agentId, projectId, Date.now(), Date.now());
}

function insertTick(db: Database, agentId: string, tickId: string): void {
  db.prepare(
    `INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES (?, ?, 'manual', ?)`,
  ).run(tickId, agentId, Date.now());
}

function insertPendingAction(
  db: Database,
  opts: {
    id: string;
    agent_id: string;
    tick_id: string;
    action_kind?: string;
    action_target?: string;
    expires_at?: number;
    project_id?: string | null;
    created_at?: number;
  },
): void {
  const createdAt = opts.created_at ?? Date.now() - 10_000;
  db.prepare(
    `INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', 'pending', ?, ?)`,
  ).run(
    opts.id,
    opts.agent_id,
    opts.tick_id,
    opts.action_kind ?? "ha:light.turn_on",
    opts.action_target ?? "light.kitchen",
    opts.expires_at ?? Date.now() + 7 * 24 * 60 * 60 * 1000,
    createdAt,
  );
}

describe("notification-sweeper: discovery", () => {
  let db: Database;
  let outbox: NotificationOutboxWriter;

  beforeEach(() => {
    db = setup();
    outbox = new NotificationOutboxWriter(db);
  });

  it("discovers task_draft events and enqueues notification outbox entries", () => {
    writeDraftEvent(db, {
      event_id: "evt-1",
      project_id: "test-project",
      event_type: "task_draft",
    });

    const result = runNotificationDiscovery(db, outbox, Date.now());
    expect(result.discovered).toBe(1);

    expect(outbox.exists("task_draft", "evt-1")).toBe(true);
    expect(outbox.exists("task_draft_escalation", "evt-1")).toBe(false);
  });

  it("discovers task_draft_escalation events", () => {
    writeDraftEvent(db, {
      event_id: "evt-esc-1",
      project_id: "test-project",
      event_type: "task_draft_escalation",
    });

    const result = runNotificationDiscovery(db, outbox, Date.now());
    expect(result.discovered).toBe(1);

    expect(outbox.exists("task_draft_escalation", "evt-esc-1")).toBe(true);
  });

  it("does not re-discover already enqueued events on subsequent sweeps", () => {
    writeDraftEvent(db, { event_id: "evt-1", project_id: "test-project" });

    let result = runNotificationDiscovery(db, outbox, Date.now());
    expect(result.discovered).toBe(1);

    result = runNotificationDiscovery(db, outbox, Date.now());
    expect(result.discovered).toBe(0);
  });

  it("discovers pending actions and enqueues notification outbox entries", () => {
    insertAgent(db, "home-agent", "home-project");
    insertTick(db, "home-agent", "tick-1");
    insertPendingAction(db, {
      id: "pa-1",
      agent_id: "home-agent",
      tick_id: "tick-1",
      project_id: "home-project",
    });

    const result = runNotificationDiscovery(db, outbox, Date.now());
    expect(result.discovered).toBe(1);

    expect(outbox.exists("pending_action_created", "pa-1")).toBe(true);
  });

  it("extracts summary from task_draft payload", () => {
    writeDraftEvent(db, {
      event_id: "evt-summary",
      project_id: "p1",
      payload_json: JSON.stringify({ draft_id: "evt-summary", prompt: "Fix the login bug" }),
    });

    runNotificationDiscovery(db, outbox, Date.now());

    const rows = db
      .query<
        { summary: string | null },
        [string]
      >("SELECT summary FROM notification_outbox WHERE kind='task_draft' AND reference_id=?")
      .all("evt-summary");
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("Fix the login bug");
  });

  it("handles null project_id with _default coalesce key", () => {
    writeDraftEvent(db, { event_id: "evt-no-proj", project_id: null });

    runNotificationDiscovery(db, outbox, Date.now());

    const rows = db
      .query<
        { coalesce_key: string },
        [string]
      >("SELECT coalesce_key FROM notification_outbox WHERE reference_id=?")
      .all("evt-no-proj");
    expect(rows.length).toBe(1);
    expect(rows[0].coalesce_key).toBe("_default");
  });

  it("starts first-run discovery from a bounded lookback instead of epoch", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    writeDraftEvent(db, {
      event_id: "evt-too-old",
      project_id: "test-project",
      ts: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    });
    writeDraftEvent(db, {
      event_id: "evt-recent",
      project_id: "test-project",
      ts: new Date(now - 30 * 60 * 1000).toISOString(),
    });

    const result = runNotificationDiscovery(db, outbox, now);

    expect(result.discovered).toBe(1);
    expect(outbox.exists("task_draft", "evt-too-old")).toBe(false);
    expect(outbox.exists("task_draft", "evt-recent")).toBe(true);
  });

  it("continues a full t0 event batch instead of advancing the cursor to now", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const start = now - 30 * 60 * 1000;
    for (let i = 0; i < 201; i++) {
      writeDraftEvent(db, {
        event_id: `evt-batch-${String(i)}`,
        project_id: "test-project",
        ts: new Date(start + i).toISOString(),
      });
    }

    const first = runNotificationDiscovery(db, outbox, now);
    const second = runNotificationDiscovery(db, outbox, now + 1000);

    expect(first.discovered).toBe(200);
    expect(second.discovered).toBe(1);
    expect(outbox.exists("task_draft", "evt-batch-200")).toBe(true);
  });

  it("does not skip draft events that share the same timestamp across batches", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const ts = new Date(now - 30 * 60 * 1000).toISOString();
    for (let i = 0; i < 201; i++) {
      writeDraftEvent(db, {
        event_id: `evt-tie-${String(i)}`,
        project_id: "test-project",
        ts,
      });
    }

    const first = runNotificationDiscovery(db, outbox, now);
    const second = runNotificationDiscovery(db, outbox, now + 1000);

    expect(first.discovered).toBe(200);
    expect(second.discovered).toBe(1);
    expect(outbox.exists("task_draft", "evt-tie-200")).toBe(true);
  });

  it("leaves events inside the discovery settle buffer for the next pass", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    writeDraftEvent(db, {
      event_id: "evt-buffered",
      project_id: "test-project",
      ts: new Date(now - 1000).toISOString(),
    });

    const first = runNotificationDiscovery(db, outbox, now);
    const second = runNotificationDiscovery(db, outbox, now + 10_000);

    expect(first.discovered).toBe(0);
    expect(second.discovered).toBe(1);
    expect(outbox.exists("task_draft", "evt-buffered")).toBe(true);
  });
});

describe("notification-sweeper: delivery", () => {
  let db: Database;
  let outbox: NotificationOutboxWriter;

  beforeEach(() => {
    db = setup();
    outbox = new NotificationOutboxWriter(db);
  });

  it("leaves entries pending when no webhook is configured", async () => {
    const now = Date.now();
    outbox.enqueue({
      project_id: "test-project",
      kind: "task_draft",
      reference_id: "evt-1",
      summary: "test",
      created_at: now - 10 * 60 * 1000,
    });

    const result = await runNotificationDelivery({
      db,
      outbox,
      getEnv: () => undefined,
      now: () => now,
    });

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(0);

    const row = db
      .query<
        { status: string },
        [string]
      >("SELECT status FROM notification_outbox WHERE reference_id=?")
      .get("evt-1");
    expect(row?.status).toBe("pending");
  });

  it("leaves entries pending when webhook URL is not an allowed HTTPS Discord host", async () => {
    const now = Date.now();
    outbox.enqueue({
      project_id: "test-project",
      kind: "task_draft",
      reference_id: "evt-invalid-url",
      summary: "test",
      created_at: now - 10 * 60 * 1000,
    });

    const result = await runNotificationDelivery({
      db,
      outbox,
      getEnv: (key) =>
        key === "PENUMBRA_DISCORD_WEBHOOK_URL" ? "http://127.0.0.1/latest/meta-data" : undefined,
      now: () => now,
    });

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(0);

    const row = db
      .query<
        { status: string; attempt_count: number },
        [string]
      >("SELECT status, attempt_count FROM notification_outbox WHERE reference_id=?")
      .get("evt-invalid-url");
    expect(row?.status).toBe("pending");
    expect(row?.attempt_count).toBe(0);
  });

  it("does not deliver entries within the coalesce window", async () => {
    const now = Date.now();
    outbox.enqueue({
      project_id: "test-project",
      kind: "task_draft",
      reference_id: "evt-recent",
      summary: "recent",
      created_at: now,
    });

    const result = await runNotificationDelivery({
      db,
      outbox,
      getEnv: () => undefined,
      now: () => now,
    });

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("groups entries by coalesce key", async () => {
    const now = Date.now();
    const created = now - 10 * 60 * 1000;

    outbox.enqueue({
      project_id: "proj-a",
      kind: "task_draft",
      reference_id: "evt-1",
      summary: "draft 1",
      created_at: created,
    });
    outbox.enqueue({
      project_id: "proj-a",
      kind: "task_draft_escalation",
      reference_id: "evt-2",
      summary: "escalation 1",
      created_at: created,
    });
    outbox.enqueue({
      project_id: "proj-b",
      kind: "task_draft",
      reference_id: "evt-3",
      summary: "draft 2",
      created_at: created,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response("ok", { status: 204 }));
    let result: Awaited<ReturnType<typeof runNotificationDelivery>>;
    try {
      result = await runNotificationDelivery({
        db,
        outbox,
        getEnv: (key) =>
          key === "PENUMBRA_DISCORD_WEBHOOK_URL"
            ? "https://discord.com/api/webhooks/test/token"
            : undefined,
        now: () => now,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.delivered).toBe(3);
    expect(result.groups).toBe(2);
  });

  it("retries retryable webhook failures with deliver_after backoff", async () => {
    const now = Date.now();
    outbox.enqueue({
      project_id: "test-project",
      kind: "task_draft",
      reference_id: "evt-retry",
      summary: "test",
      created_at: now - 10 * 60 * 1000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response("bad gateway", { status: 502 }));
    try {
      const result = await runNotificationDelivery({
        db,
        outbox,
        getEnv: (key) =>
          key === "PENUMBRA_DISCORD_WEBHOOK_URL"
            ? "https://discord.com/api/webhooks/test/token"
            : undefined,
        now: () => now,
      });

      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(1);

      const row = db
        .query<
          {
            status: string;
            attempt_count: number;
            deliver_after: number | null;
            error: string | null;
          },
          [string]
        >(
          "SELECT status, attempt_count, deliver_after, error FROM notification_outbox WHERE reference_id=?",
        )
        .get("evt-retry");
      expect(row?.status).toBe("pending");
      expect(row?.attempt_count).toBe(1);
      expect(row?.deliver_after).toBeGreaterThan(now);
      expect(row?.error).toBe("discord_post_failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks retryable webhook failures failed after max attempts", async () => {
    const now = Date.now();
    outbox.enqueue({
      project_id: "test-project",
      kind: "task_draft",
      reference_id: "evt-exhausted",
      summary: "test",
      created_at: now - 10 * 60 * 1000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response("bad gateway", { status: 502 }));
    try {
      const result = await runNotificationDelivery({
        db,
        outbox,
        getEnv: (key) => {
          if (key === "PENUMBRA_DISCORD_WEBHOOK_URL") {
            return "https://discord.com/api/webhooks/test/token";
          }
          if (key === "PENUMBRA_NOTIFICATION_MAX_ATTEMPTS") return "1";
          return undefined;
        },
        now: () => now,
      });

      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(1);

      const row = db
        .query<
          { status: string; deliver_after: number | null },
          [string]
        >("SELECT status, deliver_after FROM notification_outbox WHERE reference_id=?")
        .get("evt-exhausted");
      expect(row?.status).toBe("failed");
      expect(row?.deliver_after).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks terminal webhook failures failed without retrying", async () => {
    const now = Date.now();
    outbox.enqueue({
      project_id: "test-project",
      kind: "task_draft",
      reference_id: "evt-terminal",
      summary: "test",
      created_at: now - 10 * 60 * 1000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response("invalid webhook", { status: 400 }));
    try {
      const result = await runNotificationDelivery({
        db,
        outbox,
        getEnv: (key) =>
          key === "PENUMBRA_DISCORD_WEBHOOK_URL"
            ? "https://discord.com/api/webhooks/test/token"
            : undefined,
        now: () => now,
      });

      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(1);

      const row = db
        .query<
          { status: string; error: string | null },
          [string]
        >("SELECT status, error FROM notification_outbox WHERE reference_id=?")
        .get("evt-terminal");
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe("discord_post_failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reclaims stale processing entries before delivery", async () => {
    const now = Date.now();
    outbox.enqueue({
      project_id: "test-project",
      kind: "task_draft",
      reference_id: "evt-stale-processing",
      summary: "test",
      created_at: now - 10 * 60 * 1000,
    });
    const id = outbox.listPending(10)[0].id;
    expect(outbox.markProcessing(id, now - 10 * 60 * 1000)).toBe(true);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response("ok", { status: 204 }));
    try {
      const result = await runNotificationDelivery({
        db,
        outbox,
        getEnv: (key) =>
          key === "PENUMBRA_DISCORD_WEBHOOK_URL"
            ? "https://discord.com/api/webhooks/test/token"
            : undefined,
        now: () => now,
      });

      expect(result.delivered).toBe(1);

      const row = db
        .query<
          { status: string; attempt_count: number },
          [string]
        >("SELECT status, attempt_count FROM notification_outbox WHERE reference_id=?")
        .get("evt-stale-processing");
      expect(row?.status).toBe("done");
      expect(row?.attempt_count).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("selects the oldest rows before grouping by coalesce key", async () => {
    const now = Date.now();
    const created = now - 10 * 60 * 1000;
    outbox.enqueue({
      project_id: "zz-old",
      kind: "task_draft",
      reference_id: "evt-oldest",
      summary: "oldest",
      created_at: created,
    });
    for (let i = 0; i < 50; i++) {
      outbox.enqueue({
        project_id: "aa-newer",
        kind: "task_draft",
        reference_id: `evt-newer-${String(i)}`,
        summary: "newer",
        created_at: created + 1 + i,
      });
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response("ok", { status: 204 }));
    try {
      await runNotificationDelivery({
        db,
        outbox,
        getEnv: (key) =>
          key === "PENUMBRA_DISCORD_WEBHOOK_URL"
            ? "https://discord.com/api/webhooks/test/token"
            : undefined,
        now: () => now,
      });

      const row = db
        .query<
          { status: string },
          [string]
        >("SELECT status FROM notification_outbox WHERE reference_id=?")
        .get("evt-oldest");
      expect(row?.status).toBe("done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("notification-sweeper: round-trip", () => {
  it("discovers draft events from t0_events, enqueues, and delivers notification outbox entries", async () => {
    const db = setup();
    const outbox = new NotificationOutboxWriter(db);

    writeDraftEvent(db, {
      event_id: "evt-draft-1",
      project_id: "my-project",
      event_type: "task_draft",
      payload_json: JSON.stringify({ draft_id: "d1", prompt: "Fix the CI pipeline" }),
    });

    writeDraftEvent(db, {
      event_id: "evt-esc-1",
      project_id: "my-project",
      event_type: "task_draft_escalation",
      payload_json: JSON.stringify({
        draft_id: "d1",
        escalation_reason: "stuck refining",
      }),
    });

    const now = Date.now();
    const result = await runNotificationSweep({
      db,
      outbox,
      getEnv: () => undefined,
      now: () => now,
    });

    expect(result.discovery.discovered).toBe(2);

    const outboxRows = db
      .query<{ kind: string; status: string }, []>("SELECT kind, status FROM notification_outbox")
      .all();
    expect(outboxRows.length).toBe(2);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): Promise<Response> =>
      Promise.resolve(new Response("ok", { status: 204 }));
    try {
      const deliveredResult = await runNotificationDelivery({
        db,
        outbox,
        getEnv: (key) =>
          key === "PENUMBRA_DISCORD_WEBHOOK_URL"
            ? "https://discord.com/api/webhooks/test/token"
            : undefined,
        now: () => now + 10 * 60 * 1000,
      });
      expect(deliveredResult.delivered).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
