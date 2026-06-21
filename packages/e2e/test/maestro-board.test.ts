import type { AgentDescriptor, Services } from "@penumbra/core";

import {
  buildServices,
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBoundsCallbacks } from "../../daemon/src/maestro/bounds-callbacks.js";
import { createBoundsTracker } from "../../daemon/src/maestro/bounds-tracker.js";
import { createOrchestrateReactor } from "../../daemon/src/reactors/orchestrate-reactor.js";
import { chainStartInternal } from "../../daemon/src/routes/chains.js";
import { createDaemonFetchHandler } from "../../daemon/src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded or not available */
}

interface TaskEvent {
  task_id: string;
  at: number;
  kind: string;
  actor: string | null;
  payload: unknown;
}

interface TaskLeaseResponse {
  task_id: string;
  lease_id: string;
  expires_at: number;
}

interface MaestroHarness {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  token: string;
  db: Database;
  services: Services;
  taskEvents: TaskEventBus;
  taskWriter: TaskWriter;
  sessions: MaestroSessionWriter;
  tracker: { tick(): void };
  setNow: (nextMs: number) => void;
  nowMs: () => number;
  injectCalls: { chain_handoff_id: string; message: { role: "user"; text: string } }[];
  chainCancelCalls: string[];
  stop: () => void;
}

const MAESTRO_AGENT = {
  name: "e2e-maestro-stub",
  adapter: "noop",
  options: {},
  tier: "oc",
  tags: ["orchestrator"],
  maestro_capable: true,
  cost_cents_per_run: 1,
};
const MAESTRO_DESCRIPTOR: AgentDescriptor = {
  name: MAESTRO_AGENT.name,
  tier: MAESTRO_AGENT.tier,
  tags: MAESTRO_AGENT.tags,
  maestro_capable: true,
};

function createHarness(): MaestroHarness {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), "maestro-e2e-"));
  const worktreeRootDir = join(root, "worktrees");
  const mainRepoDir = join(root, "main");
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });

  let now = Date.parse("2026-05-05T00:00:00.000Z");
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date(now),
    uuid: (): string => `id-${String(++n)}`,
    agentRegistry: [MAESTRO_AGENT.name],
    worktreeRootDir,
    mainRepoDir,
  });
  services.watchdog = {
    recordHeartbeat(): void {
      /* no-op for e2e */
    },
    hasActiveWorker(): boolean {
      return true;
    },
    tick(): Promise<void> {
      return Promise.resolve();
    },
  };
  (services as Services & { agentchatConfig?: unknown }).agentchatConfig = {
    agents: [MAESTRO_AGENT],
    default_roles: {},
  };

  const resolveAgent = (name: string): AgentDescriptor | undefined =>
    name === MAESTRO_DESCRIPTOR.name ? MAESTRO_DESCRIPTOR : undefined;

  const taskEvents = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db, now: (): number => now });
  const chainCancelCalls: string[] = [];
  const taskWriter = new TaskWriter(db, {
    now: (): number => now,
    bus: taskEvents,
    resolveAgent,
    maestroSessions: sessions,
    onOrchestrateCancel: (chain_handoff_id: string): void => {
      chainCancelCalls.push(chain_handoff_id);
    },
  });

  const injectCalls: { chain_handoff_id: string; message: { role: "user"; text: string } }[] = [];
  const boundsCallbacks = createBoundsCallbacks({
    db,
    taskWriter,
    sessions,
    injector: {
      inject: (chain_handoff_id, message): Promise<void> => {
        injectCalls.push({ chain_handoff_id, message });
        return Promise.resolve();
      },
    },
    bus: taskEvents,
    chainCancel: (chain_handoff_id): Promise<void> => {
      chainCancelCalls.push(chain_handoff_id);
      return Promise.resolve();
    },
    now: (): number => now,
  });
  const tracker = createBoundsTracker({
    db,
    sessions,
    now: () => now,
    intervalMs: 60_000,
    warnThreshold: 0.8,
    onSoftWarn: boundsCallbacks.onSoftWarn,
    onHardKill: boundsCallbacks.onHardKill,
  });

  const orchestrateReactor = createOrchestrateReactor({
    db,
    bus: taskEvents,
    sessions,
    taskWriter,
    chainStart: async (request) => {
      const response = await chainStartInternal(request, services, {
        applyMaestroBudgetGate: false,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`chain_start failed (${String(response.status)}): ${body}`);
      }
      const data = (await response.json()) as { handoff_id?: unknown; conversation_id?: unknown };
      if (typeof data.handoff_id !== "string" || typeof data.conversation_id !== "string") {
        throw new Error("chain_start returned malformed response");
      }
      return { handoff_id: data.handoff_id, conversation_id: data.conversation_id };
    },
    resolveAgent,
    defaults: {
      wall_clock_ms: 1_800_000,
      cost_cents: 200,
      sub_dispatches: 10,
    },
    now: () => now,
  });
  orchestrateReactor.start();

  const token = "tok";
  const handler = createDaemonFetchHandler({
    services,
    token,
    taskEvents,
    taskWriter,
  });

  return {
    fetch: (path, init) => handler(new Request(`http://x${path}`, init)),
    token,
    db,
    services,
    taskEvents,
    taskWriter,
    sessions,
    tracker,
    setNow: (nextMs): void => {
      now = nextMs;
    },
    nowMs: (): number => now,
    injectCalls,
    chainCancelCalls,
    stop: (): void => {
      try {
        orchestrateReactor.stop();
      } catch {
        /* best-effort */
      }
      try {
        services.supervisor.stopAll();
      } catch {
        /* best-effort */
      }
      try {
        db.close();
      } catch {
        /* best-effort */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function authHeaders(token: string, headers: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...headers,
  };
}

async function postJson(harness: MaestroHarness, path: string, body: unknown): Promise<Response> {
  return await harness.fetch(path, {
    method: "POST",
    headers: authHeaders(harness.token, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function readSseFrames(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: TaskEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let splitAt = buffer.indexOf("\n\n");
      while (splitAt >= 0) {
        const frame = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine) {
          onEvent(JSON.parse(dataLine.slice(6)) as TaskEvent);
        }
        splitAt = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error: unknown) {
      if (Date.now() - started >= timeoutMs) {
        throw error;
      }
      await Bun.sleep(20);
    }
  }
}

async function waitForEvent(
  events: TaskEvent[],
  predicate: (event: TaskEvent) => boolean,
  timeoutMs: number,
): Promise<TaskEvent> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for event after ${String(timeoutMs)}ms`);
}

test("maestro board smoke: orchestrate spawn, sub-dispatch accounting, completion, and SSE", async () => {
  const harness = createHarness();
  const abort = new AbortController();
  let streamDone: Promise<void> | null = null;
  let sseBody: ReadableStream<Uint8Array> | null = null;
  try {
    const sseRes = await harness.fetch(
      "/tasks/events?kind=orchestrate_spawned,orchestrate_warning,orchestrate_terminated",
      { headers: authHeaders(harness.token), signal: abort.signal },
    );
    expect(sseRes.status).toBe(200);
    expect(sseRes.body).toBeTruthy();
    sseBody = sseRes.body!;

    const streamEvents: TaskEvent[] = [];
    streamDone = readSseFrames(sseBody, (event) => {
      streamEvents.push(event);
    });

    const filed = await postJson(harness, "/tasks", {
      prompt: "investigate foo",
      kind: "orchestrate",
      created_by_kind: "human",
      created_by_id: "cli",
      eligibility: { allow_agents: [MAESTRO_AGENT.name] },
      bounds: {
        wall_clock_ms: 300_000,
        cost_cents: 100,
        max_sub_dispatches: 5,
      },
    });
    expect(filed.status).toBe(201);
    const filedBody = (await filed.json()) as { task_id: string };
    const taskId = filedBody.task_id;

    await waitFor(() => {
      const session = harness.sessions.get(taskId);
      expect(session).toBeTruthy();
    });

    const session = harness.sessions.get(taskId);
    expect(session).toBeTruthy();
    expect(session?.wall_clock_budget_ms).toBe(300_000);
    expect(session?.cost_budget_cents).toBe(100);
    expect(session?.sub_dispatch_budget).toBe(5);
    expect(session?.agent_id).toBe(MAESTRO_AGENT.name);
    expect(harness.taskWriter.get(taskId).status).toBe("leased");

    const sub1 = await postJson(harness, "/tasks", {
      prompt: "subtask 1",
      kind: "work",
      parent_task_id: taskId,
      created_by_kind: "agent",
      created_by_id: MAESTRO_AGENT.name,
    });
    const sub2 = await postJson(harness, "/tasks", {
      prompt: "subtask 2",
      kind: "work",
      parent_task_id: taskId,
      created_by_kind: "agent",
      created_by_id: MAESTRO_AGENT.name,
    });
    expect(sub1.status).toBe(201);
    expect(sub2.status).toBe(201);

    const chainStart = await postJson(harness, "/chains/start", {
      initial_agent: MAESTRO_AGENT.name,
      message: "child dispatch",
      parent_handoff_id: session?.chain_handoff_id,
      task_type: "implement_small",
      use_worktree: true,
      trust_mode: "all",
    });
    expect(chainStart.status).toBe(200);

    await waitFor(() => {
      const next = harness.sessions.get(taskId);
      expect(next?.sub_dispatches_consumed).toBe(1);
    });

    const leaseSub = await postJson(harness, "/tasks/lease", { agent_id: MAESTRO_AGENT.name });
    expect(leaseSub.status).toBe(200);
    const leaseSubBody = (await leaseSub.json()) as TaskLeaseResponse;
    const completeSub = await postJson(harness, `/tasks/${leaseSubBody.task_id}/complete`, {
      lease_id: leaseSubBody.lease_id,
      result_summary: "subtask done",
    });
    expect(completeSub.status).toBe(200);

    const orchestrateLease = harness.db
      .query<{ id: string }, [string]>(
        `SELECT id
         FROM task_leases
         WHERE task_id = ? AND released_at IS NULL
         ORDER BY claimed_at DESC
         LIMIT 1`,
      )
      .get(taskId);
    expect(orchestrateLease).toBeTruthy();

    const completeMain = await postJson(harness, `/tasks/${taskId}/complete`, {
      lease_id: orchestrateLease?.id,
      result_summary: "done",
    });
    expect(completeMain.status).toBe(200);

    harness.setNow(harness.nowMs() + 301_000);
    harness.tracker.tick();
    await Bun.sleep(0);

    const completed = harness.taskWriter.get(taskId);
    expect(completed.status).toBe("done");

    const subCount = harness.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ? AND kind = 'work'`)
      .get(taskId);
    expect(subCount?.n).toBe(2);

    const ended = harness.sessions.get(taskId);
    expect(ended?.terminated_at).not.toBeNull();
    expect(ended?.termination_reason).toBe("completed");

    await waitFor(() => {
      const row = harness.db
        .query<
          { n: number },
          [string]
        >(`SELECT COUNT(*) AS n FROM agent_performance WHERE agent_name = ?`)
        .get(MAESTRO_AGENT.name);
      expect((row?.n ?? 0) > 0).toBe(true);
    });

    const spawned = harness.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'orchestrate_spawned'`)
      .get(taskId);
    expect((spawned?.n ?? 0) > 0).toBe(true);
    expect(
      streamEvents.some(
        (event) => event.task_id === taskId && event.kind === "orchestrate_terminated",
      ),
    ).toBe(false);
  } finally {
    abort.abort();
    if (sseBody) {
      try {
        await sseBody.cancel();
      } catch {
        /* already closed */
      }
    }
    if (streamDone) {
      await Promise.race([streamDone.catch((): void => undefined), Bun.sleep(100)]);
    }
    harness.stop();
  }
}, 30_000);

test("maestro board variant A: 80% wall-clock emits warning and ACP inject", async () => {
  const harness = createHarness();
  const abort = new AbortController();
  let streamDone: Promise<void> | null = null;
  let sseBody: ReadableStream<Uint8Array> | null = null;
  try {
    const sseRes = await harness.fetch("/tasks/events?kind=orchestrate_warning", {
      headers: authHeaders(harness.token),
      signal: abort.signal,
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.body).toBeTruthy();
    sseBody = sseRes.body!;
    const streamEvents: TaskEvent[] = [];
    streamDone = readSseFrames(sseBody, (event) => {
      streamEvents.push(event);
    });

    const filed = await postJson(harness, "/tasks", {
      prompt: "warn at 80%",
      kind: "orchestrate",
      created_by_kind: "human",
      created_by_id: "cli",
      eligibility: { allow_agents: [MAESTRO_AGENT.name] },
      bounds: {
        wall_clock_ms: 60_000,
        cost_cents: 100,
        max_sub_dispatches: 5,
      },
    });
    expect(filed.status).toBe(201);
    const taskId = ((await filed.json()) as { task_id: string }).task_id;

    await waitFor(() => {
      expect(harness.sessions.get(taskId)).toBeTruthy();
    });

    harness.setNow(harness.nowMs() + 50_000);
    harness.tracker.tick();
    await Bun.sleep(0);

    expect(harness.injectCalls.length).toBe(1);
    expect(harness.injectCalls[0]?.message.text).toContain("BUDGET WARNING");
    expect(harness.sessions.get(taskId)?.soft_warned_at).toBe(harness.nowMs());

    await waitForEvent(
      streamEvents,
      (event) => event.task_id === taskId && event.kind === "orchestrate_warning",
      2_000,
    );
  } finally {
    abort.abort();
    if (sseBody) {
      try {
        await sseBody.cancel();
      } catch {
        /* already closed */
      }
    }
    if (streamDone) {
      await Promise.race([streamDone.catch((): void => undefined), Bun.sleep(100)]);
    }
    harness.stop();
  }
}, 20_000);

test("maestro board variant B: 100% wall-clock hard-kill fails task and cancels chain", async () => {
  const harness = createHarness();
  const abort = new AbortController();
  let streamDone: Promise<void> | null = null;
  let sseBody: ReadableStream<Uint8Array> | null = null;
  try {
    const sseRes = await harness.fetch("/tasks/events?kind=orchestrate_terminated", {
      headers: authHeaders(harness.token),
      signal: abort.signal,
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.body).toBeTruthy();
    sseBody = sseRes.body!;
    const streamEvents: TaskEvent[] = [];
    streamDone = readSseFrames(sseBody, (event) => {
      streamEvents.push(event);
    });

    const filed = await postJson(harness, "/tasks", {
      prompt: "hard kill at 100%",
      kind: "orchestrate",
      created_by_kind: "human",
      created_by_id: "cli",
      eligibility: { allow_agents: [MAESTRO_AGENT.name] },
      bounds: {
        wall_clock_ms: 10_000,
        cost_cents: 100,
        max_sub_dispatches: 5,
      },
    });
    expect(filed.status).toBe(201);
    const taskId = ((await filed.json()) as { task_id: string }).task_id;

    await waitFor(() => {
      expect(harness.sessions.get(taskId)).toBeTruthy();
    });
    const session = harness.sessions.get(taskId);
    expect(session).toBeTruthy();

    harness.setNow(harness.nowMs() + 11_000);
    harness.tracker.tick();
    await Bun.sleep(0);

    const task = harness.taskWriter.get(taskId);
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toContain("bounds_exceeded:wall_clock");

    const ended = harness.sessions.get(taskId);
    expect(ended?.terminated_at).not.toBeNull();
    expect(ended?.termination_reason).toBe("bounds_exceeded:wall_clock");

    expect(harness.chainCancelCalls).toContain(session?.chain_handoff_id);

    const terminated = harness.db
      .query<
        { payload_json: string | null },
        [string]
      >(`SELECT payload_json FROM task_events WHERE task_id = ? AND kind = 'orchestrate_terminated' ORDER BY id DESC LIMIT 1`)
      .get(taskId);
    expect(terminated).toBeTruthy();
    const payload = JSON.parse(terminated?.payload_json ?? "{}") as { reason?: string };
    expect(payload.reason).toBe("bounds_exceeded:wall_clock");

    await waitForEvent(
      streamEvents,
      (event) => event.task_id === taskId && event.kind === "orchestrate_terminated",
      2_000,
    );
  } finally {
    abort.abort();
    if (sseBody) {
      try {
        await sseBody.cancel();
      } catch {
        /* already closed */
      }
    }
    if (streamDone) {
      await Promise.race([streamDone.catch((): void => undefined), Bun.sleep(100)]);
    }
    harness.stop();
  }
}, 20_000);
