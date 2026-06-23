import type { AgentDescriptor, ChainStartRequest } from "@penumbra/core";

import {
  loadSqliteVec,
  MaestroSessionWriter,
  migrate,
  routeAgent,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { createOrchestrateReactor } from "../../src/reactors/orchestrate-reactor.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // ignore: platform-specific sqlite setup
}

const DEFAULT_BOUNDS = {
  wall_clock_ms: 1_800_000,
  cost_cents: 200,
  sub_dispatches: 10,
};

const AGENT_A: AgentDescriptor = {
  name: "agent-a",
  maestro_capable: true,
  tags: ["typescript"],
  tier: "premium",
};

const AGENT_B: AgentDescriptor = {
  name: "agent-b",
  maestro_capable: true,
  tags: ["typescript"],
  tier: "premium",
};

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch {
      // assertion failed; retry after sleep
      await Bun.sleep(20);
    }
  }
  throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`);
}

afterEach(() => {
  mock.restore();
  return Bun.sleep(5);
});

type ReactorResult = {
  db: Database;
  bus: TaskEventBus;
  sessions: MaestroSessionWriter;
  taskWriter: TaskWriter;
  chainStartCalls: ChainStartRequest[];
  reactor: { start: () => void; stop: () => void };
};

function makeReactor(routeAgentImpl?: typeof routeAgent): ReactorResult {
  const db = setupDb();
  const bus = new TaskEventBus();
  const sessions = new MaestroSessionWriter({ db });
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name): AgentDescriptor | undefined =>
      name === AGENT_A.name ? AGENT_A : name === AGENT_B.name ? AGENT_B : undefined,
  });

  const chainStartCalls: ChainStartRequest[] = [];
  const reactor = createOrchestrateReactor({
    db,
    bus,
    sessions,
    taskWriter,
    chainStart: (
      req: ChainStartRequest,
    ): Promise<{ handoff_id: string; conversation_id: string }> => {
      chainStartCalls.push(req);
      return Promise.resolve({ handoff_id: "handoff-1", conversation_id: "conv-1" });
    },
    resolveAgent: (name): AgentDescriptor | undefined =>
      name === AGENT_A.name ? AGENT_A : name === AGENT_B.name ? AGENT_B : undefined,
    defaults: DEFAULT_BOUNDS,
    routeAgent: routeAgentImpl,
  });

  return { db, bus, sessions, taskWriter, chainStartCalls, reactor };
}

test("spawns the only allowed agent without querying rankAgents", async () => {
  const routeAgentMock = mock(() => {
    throw new Error("rankAgents should not run for a single allowed agent");
  }) as unknown as typeof routeAgent;
  const { db, taskWriter, sessions, chainStartCalls, reactor } = makeReactor(routeAgentMock);
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [AGENT_A.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    const session = sessions.get(task_id);
    expect(session).toBeTruthy();
  });

  expect(chainStartCalls).toHaveLength(1);
  expect(chainStartCalls[0]?.initial_agent).toBe(AGENT_A.name);
  expect(routeAgentMock).toHaveBeenCalledTimes(0);

  reactor.stop();
  db.close();
});

test("spawns the highest-ranked allowed agent when rankAgents returns an overlapping order", async () => {
  const routeAgentMock = mock(() => ({
    detail: "rank" as const,
    candidates: {
      task_type: "implement_substantial",
      window: { from: null, to: "2026-05-05T12:00:00.000Z" },
      candidates: [
        { agent_name: AGENT_B.name, score: 0.9 },
        { agent_name: AGENT_A.name, score: 0.5 },
      ],
    },
  })) as unknown as typeof routeAgent;
  const { db, taskWriter, sessions, chainStartCalls, reactor } = makeReactor(routeAgentMock);
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [AGENT_A.name, AGENT_B.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    const session = sessions.get(task_id);
    expect(session).toBeTruthy();
  });

  expect(routeAgentMock).toHaveBeenCalledTimes(1);
  expect(chainStartCalls).toHaveLength(1);
  expect(chainStartCalls[0]?.initial_agent).toBe(AGENT_B.name);

  reactor.stop();
  db.close();
});

test("falls back to the first allowed agent when rankAgents throws", async () => {
  const routeAgentMock = mock(() => {
    throw new Error("rank lookup failed");
  }) as unknown as typeof routeAgent;
  const warnSpy = spyOn(console, "warn").mockImplementation((): void => undefined);
  const { db, taskWriter, sessions, chainStartCalls, reactor } = makeReactor(routeAgentMock);
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [AGENT_A.name, AGENT_B.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    const session = sessions.get(task_id);
    expect(session).toBeTruthy();
  });

  expect(routeAgentMock).toHaveBeenCalledTimes(1);
  expect(chainStartCalls).toHaveLength(1);
  expect(chainStartCalls[0]?.initial_agent).toBe(AGENT_A.name);
  expect(warnSpy).toHaveBeenCalledTimes(1);

  reactor.stop();
  db.close();
});

test("falls back to the first allowed agent when rankAgents has no overlap", async () => {
  const routeAgentMock = mock(() => ({
    detail: "rank" as const,
    candidates: {
      task_type: "implement_substantial",
      window: { from: null, to: "2026-05-05T12:00:00.000Z" },
      candidates: [{ agent_name: "agent-c", score: 0.9 }],
    },
  })) as unknown as typeof routeAgent;
  const warnSpy = spyOn(console, "warn").mockImplementation((): void => undefined);
  const { db, taskWriter, sessions, chainStartCalls, reactor } = makeReactor(routeAgentMock);
  reactor.start();

  const { task_id } = taskWriter.file({
    prompt: "Ship task 3.2",
    kind: "orchestrate",
    eligibility: { allow_agents: [AGENT_A.name, AGENT_B.name] },
    created_by_kind: "human",
    created_by_id: "cli",
  });

  await waitFor(() => {
    const session = sessions.get(task_id);
    expect(session).toBeTruthy();
  });

  expect(routeAgentMock).toHaveBeenCalledTimes(1);
  expect(chainStartCalls).toHaveLength(1);
  expect(chainStartCalls[0]?.initial_agent).toBe(AGENT_A.name);
  expect(warnSpy).toHaveBeenCalledTimes(1);

  reactor.stop();
  db.close();
});
