import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { createMcpEventBus } from "@penumbra/daemon/events/mcp-event-bus";
import { createLongLivedReactor } from "@penumbra/daemon/reactors/long-lived-reactor";
import { Database } from "bun:sqlite";
import { describe, expect, it, mock, spyOn } from "bun:test";

import type {
  FederationHealthSnapshot,
  McpPool,
  McpToolDescriptor,
} from "../../src/long-lived/mcp-pool.js";

interface AgentRecord {
  name: string;
  long_lived: boolean;
  long_lived_config: {
    schedule_cron: string;
    subscriptions: { server: string; event: string }[];
    mcp_allowlist: string[];
    bounds: { wall_clock_ms: number; cost_cents: number; max_sub_dispatches: number };
    circuit_breaker_threshold: number;
    standing_brief: string;
  };
}

const fakeAgent: AgentRecord = {
  name: "home",
  long_lived: true,
  long_lived_config: {
    schedule_cron: "*/5 * * * *",
    subscriptions: [{ server: "ha", event: "state_changed" }],
    mcp_allowlist: ["ha:state.*"],
    bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
    circuit_breaker_threshold: 3,
    standing_brief: "x",
  },
};

function makeMcpPool(): McpPool {
  const empty: FederationHealthSnapshot = { registered: [], skipped: [] };
  return {
    ensureRunning: () => Promise.resolve(),
    callTool: () => Promise.resolve(undefined),
    listTools: () => Promise.resolve<McpToolDescriptor[]>([]),
    acquire: () => undefined,
    release: () => undefined,
    getFederationHealth: () => empty,
    shutdown: () => Promise.resolve(),
  };
}

interface LogRow {
  status: string;
}

describe("long-lived reactor", () => {
  it("reconciles, registers a cron job, and fires spawn on cron testFire", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const bus = createMcpEventBus();
    const spawn = mock((): Promise<{ chain_id: string }> => Promise.resolve({ chain_id: "ch1" }));
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      isChainActive: () => false,
      now: () => 100,
      mcpPool: makeMcpPool(),
      loadAgentchatYaml: () => Promise.resolve({ agents: [fakeAgent] }),
    });

    await reactor.reload();
    reactor._cronTestFire("home");

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("subscribes to MCP events and fires spawn on a matching publish", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const bus = createMcpEventBus();
    const spawn = mock((): Promise<{ chain_id: string }> => Promise.resolve({ chain_id: "ch1" }));
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      isChainActive: () => false,
      now: () => 100,
      mcpPool: makeMcpPool(),
      loadAgentchatYaml: () => Promise.resolve({ agents: [fakeAgent] }),
    });

    await reactor.reload();
    bus.publish({
      server: "ha",
      event: "state_changed",
      payload: { entity_id: "light.kitchen" },
      published_at: 100,
    });
    await Bun.sleep(20);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reload diff retires removed agents", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const bus = createMcpEventBus();
    const spawn = mock((): Promise<{ chain_id: string }> => Promise.resolve({ chain_id: "c" }));
    let yamlAgents: AgentRecord[] = [fakeAgent];
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      isChainActive: () => false,
      now: () => 100,
      mcpPool: makeMcpPool(),
      loadAgentchatYaml: () => Promise.resolve({ agents: yamlAgents }),
    });

    await reactor.reload();
    expect(reactor._cronList()).toEqual([
      "home",
      "__sweeper_pending_expiry__",
      "__sweeper_snapshot_purge__",
    ]);

    yamlAgents = [];
    await reactor.reload();

    expect(reactor._cronList()).toEqual([
      "__sweeper_pending_expiry__",
      "__sweeper_snapshot_purge__",
    ]);
    const row = db.query<LogRow, []>("SELECT status FROM long_lived_agents WHERE id='home'").get();
    expect(row?.status).toBe("retired");
  });

  it("registers the long-lived sweepers on reload", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const bus = createMcpEventBus();
    const spawn = mock((): Promise<{ chain_id: string }> => Promise.resolve({ chain_id: "c" }));
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      isChainActive: () => false,
      now: () => 100,
      mcpPool: makeMcpPool(),
      loadAgentchatYaml: () => Promise.resolve({ agents: [] }),
    });

    await reactor.reload();

    expect(reactor._cronList()).toEqual([
      "__sweeper_pending_expiry__",
      "__sweeper_snapshot_purge__",
    ]);
  });

  it("logs and swallows tick chain DB write failures", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    const bus = createMcpEventBus();
    const spawn = mock((): Promise<{ chain_id: string }> => Promise.resolve({ chain_id: "ch1" }));
    const error = mock((): undefined => undefined);
    const warn = mock((): undefined => undefined);
    const reactor = createLongLivedReactor({
      db,
      bus,
      spawn,
      isChainActive: () => false,
      now: () => 100,
      mcpPool: makeMcpPool(),
      log: stubLogger({ error, warn }),
      loadAgentchatYaml: () => Promise.resolve({ agents: [fakeAgent] }),
    });

    await reactor.reload();
    const originalQuery = db.query.bind(db);
    type QueryFn = (sql: string, ...args: unknown[]) => unknown;
    const querySpy = spyOn(db as unknown as { query: QueryFn }, "query").mockImplementation(
      (sql: string, ...args: unknown[]): unknown => {
        if (sql === "UPDATE long_lived_ticks SET chain_id=? WHERE id=?") {
          return {
            run: (): never => {
              throw new Error("db locked");
            },
          };
        }
        return (originalQuery as unknown as QueryFn)(sql, ...args);
      },
    );

    const unhandled = mock((): undefined => undefined);
    process.on("unhandledRejection", unhandled);
    try {
      reactor._cronTestFire("home");
      await Bun.sleep(25);
      expect(error).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      querySpy.mockRestore();
    }
  });
});

type LoggerArg = NonNullable<Parameters<typeof createLongLivedReactor>[0]["log"]>;

function stubLogger(
  overrides: Partial<Record<"error" | "warn" | "info" | "debug" | "trace" | "fatal", unknown>>,
): LoggerArg {
  const noop = (): undefined => undefined;
  const base = {
    error: overrides.error ?? noop,
    warn: overrides.warn ?? noop,
    info: overrides.info ?? noop,
    debug: overrides.debug ?? noop,
    trace: overrides.trace ?? noop,
    fatal: overrides.fatal ?? noop,
    child: (): unknown => base,
    level: "silent",
  };
  return base as unknown as LoggerArg;
}
