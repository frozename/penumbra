import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type Services,
  migrate,
  loadSqliteVec,
  HandoffWriter,
  HandoffReader,
  ConversationStreamBus,
} from "@penumbra/core";
import { handoffsCreateRoute } from "../../src/routes/handoffs.js";
import { handoffsProgressRoute } from "../../src/routes/handoffs-progress.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function makeServices(db: Database): Services {
  return makeServicesWithClock(db, () => new Date("2026-04-25T20:00:00.000Z"));
}

function makeServicesWithClock(db: Database, clock: () => Date): Services {
  const handoffEvents = { subscribe: () => {}, emit: () => {} };
  const conversationStream = new ConversationStreamBus();
  return {
    db,
    handoffWriter: new HandoffWriter({ db, events: handoffEvents as any }),
    handoffReader: new HandoffReader({ db }),
    conversationStream,
    uuid: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
    clock,
    t0Writer: { write: () => {} },
    machineId: { get: () => "machine-test" },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  } as unknown as Services;
}

function createPendingHandoff(
  services: Services,
  handoff_id: string,
  conversation_id = "conv-terminal",
): void {
  services.handoffWriter.create({
    handoff_id,
    ts: services.clock().toISOString(),
    project_id: null,
    conversation_id,
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    triggered_by_event_id: "e1",
    use_worktree: null,
  });
}

function createTerminalHandoff(
  services: Services,
  handoff_id: string,
  conversation_id = "conv-terminal",
): void {
  services.handoffWriter.createApproved({
    handoff_id,
    ts: "t",
    project_id: null,
    conversation_id,
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    triggered_by_event_id: "e1",
    resolved_by: "u1",
    resolved_at: "t",
    chain_max_hops: null,
    chain_trust_mode: null,
    use_worktree: null,
  });
  services.handoffWriter.claimDispatch(handoff_id, "w1");
  services.handoffWriter.markCompleted(handoff_id);
}

async function postProgress(
  services: Services,
  handoff_id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return handoffsProgressRoute(
    new Request(`http://x/handoffs/${handoff_id}/progress`, {
      method: "POST",
      body: JSON.stringify({ handoff_id, ...body }),
    }),
    handoff_id,
    services,
  );
}

test("POST /handoffs/:id/progress resolves conversation_id and emits to stream", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  // 1. Seed a handoff
  const createRes = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "claude",
        to: "gemini",
        message: "go",
        conversation_id: "conv-123",
        triggered_by_event_id: "e1",
      }),
    }),
    services,
  );
  const { handoff_id } = await createRes.json();

  // 2. Push hop-start
  const startReq = new Request(`http://x/handoffs/${handoff_id}/progress`, {
    method: "POST",
    body: JSON.stringify({
      type: "hop-start",
      handoff_id,
      chain_id: "conv-123",
      idx: 0,
      agent_name: "gemini",
      status: "in_progress",
    }),
  });
  await handoffsProgressRoute(startReq, handoff_id, services);

  // 3. Push token
  const progressReq = new Request(`http://x/handoffs/${handoff_id}/progress`, {
    method: "POST",
    body: JSON.stringify({
      type: "token",
      handoff_id,
      seq: 1,
      delta: "hello",
    }),
  });

  let emittedConv: string | null = null;
  let emittedEvent: any = null;
  services.conversationStream.subscribe((convId, event) => {
    emittedConv = convId;
    emittedEvent = event;
  });

  const progressRes = await handoffsProgressRoute(progressReq, handoff_id, services);
  expect(progressRes.status).toBe(200);

  // 4. Verify emission
  expect(emittedConv).toBe("conv-123");
  expect(emittedEvent).toEqual({
    type: "token",
    handoff_id,
    seq: 1,
    delta: "hello",
  });

  // 5. Verify cache
  const history = services.conversationStream.getHistory("conv-123");
  expect(history).toContainEqual(emittedEvent);
});

test("POST /handoffs/:id/progress accepts terminal handoff progress and emits to stream", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const handoff_id = "terminal-progress-emit";
  createTerminalHandoff(services, handoff_id, "c1");

  let emittedConv: string | null = null;
  let emittedEvent: any = null;
  services.conversationStream.subscribe((convId, event) => {
    emittedConv = convId;
    emittedEvent = event;
  });

  // 2. Push progress
  const res = await postProgress(services, handoff_id, { type: "token", seq: 1, delta: "..." });
  expect(res.status).toBe(200);
  expect(emittedConv).toBe("c1");
  expect(emittedEvent).toEqual({ type: "token", handoff_id, seq: 1, delta: "..." });
});

test("POST /handoffs/:id/progress accepts merge-result progress for all statuses", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const handoff_id = "h-merge";
  services.handoffWriter.createApproved({
    handoff_id,
    ts: "t",
    project_id: null,
    conversation_id: "c-merge",
    from: "a",
    to: "b",
    to_role: null,
    message: "m",
    triggered_by_event_id: "e1",
    resolved_by: "u1",
    resolved_at: "t",
    chain_max_hops: null,
    chain_trust_mode: null,
  });

  const cases = [
    { status: "merged" as const },
    { status: "rebased" as const },
    { status: "rebase_conflict" as const, conflict_files: ["src/a.ts"], worktree_dirty: true },
    { status: "test_failed" as const, regression_summary: "tests failed", timed_out: true },
    {
      status: "typecheck_failed" as const,
      regression_summary: "typecheck failed",
      timed_out: false,
    },
  ];

  for (const body of cases) {
    const res = await handoffsProgressRoute(
      new Request("http://x/handoffs/h-merge/progress", {
        method: "POST",
        body: JSON.stringify({
          type: "merge-result",
          handoff_id,
          ...body,
        }),
      }),
      handoff_id,
      services,
    );
    expect(res.status).toBe(200);
  }
});

test("POST /handoffs/:id/progress enforces the terminal cap on the 51st post", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const handoff_id = "terminal-cap-single";
  createTerminalHandoff(services, handoff_id);

  for (let i = 0; i < 50; i += 1) {
    const res = await postProgress(services, handoff_id, { type: "token", seq: i + 1, delta: "x" });
    expect(res.status).toBe(200);
  }

  const capped = await postProgress(services, handoff_id, { type: "token", seq: 51, delta: "x" });
  expect(capped.status).toBe(429);
  await expect(capped.json()).resolves.toEqual({
    error: {
      code: "progress_cap_exceeded",
      message: "terminal handoff terminal-cap-single exceeded the progress cap of 50",
    },
  });
});

test("POST /handoffs/:id/progress uses a per-handoff terminal cap", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const handoffA = "terminal-cap-a";
  const handoffB = "terminal-cap-b";
  createTerminalHandoff(services, handoffA);
  createTerminalHandoff(services, handoffB);

  for (let i = 0; i < 50; i += 1) {
    const resA = await postProgress(services, handoffA, { type: "token", seq: i + 1, delta: "a" });
    const resB = await postProgress(services, handoffB, { type: "token", seq: i + 1, delta: "b" });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
  }
});

test("POST /handoffs/:id/progress evicts terminal cap state after one hour", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  let now = new Date("2026-04-25T20:00:00.000Z");
  const services = makeServicesWithClock(db, () => new Date(now));

  const handoff_id = "terminal-cap-ttl";
  createTerminalHandoff(services, handoff_id);

  for (let i = 0; i < 50; i += 1) {
    const res = await postProgress(services, handoff_id, { type: "token", seq: i + 1, delta: "x" });
    expect(res.status).toBe(200);
  }

  now = new Date(now.getTime() + 61 * 60 * 1000);

  const res = await postProgress(services, handoff_id, { type: "token", seq: 51, delta: "x" });
  expect(res.status).toBe(200);
});

test("POST /handoffs/:id/progress bypasses the terminal cap for pending handoffs", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const handoff_id = "pending-progress";
  createPendingHandoff(services, handoff_id);

  for (let i = 0; i < 120; i += 1) {
    const res = await postProgress(services, handoff_id, { type: "token", seq: i + 1, delta: "x" });
    expect(res.status).toBe(200);
  }
});

test("POST /handoffs/:id/progress honors PENUMBRA_TERMINAL_PROGRESS_CAP", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const prior = process.env.PENUMBRA_TERMINAL_PROGRESS_CAP;
  process.env.PENUMBRA_TERMINAL_PROGRESS_CAP = "3";

  try {
    const handoff_id = "terminal-cap-env";
    createTerminalHandoff(services, handoff_id);

    for (let i = 0; i < 3; i += 1) {
      const res = await postProgress(services, handoff_id, {
        type: "token",
        seq: i + 1,
        delta: "x",
      });
      expect(res.status).toBe(200);
    }

    const capped = await postProgress(services, handoff_id, { type: "token", seq: 4, delta: "x" });
    expect(capped.status).toBe(429);
  } finally {
    if (prior === undefined) {
      delete process.env.PENUMBRA_TERMINAL_PROGRESS_CAP;
    } else {
      process.env.PENUMBRA_TERMINAL_PROGRESS_CAP = prior;
    }
  }
});

test("POST /handoffs/:id/progress returns 404 for unknown handoff", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsProgressRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ type: "token", handoff_id: "h-nope", seq: 1, delta: "..." }),
    }),
    "h-nope",
    services,
  );
  expect(res.status).toBe(404);
});

test("POST /handoffs/:id/progress returns 400 for invalid event", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const res = await handoffsProgressRoute(
    new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ type: "garbage" }),
    }),
    "h1",
    services,
  );
  expect(res.status).toBe(400);
});
