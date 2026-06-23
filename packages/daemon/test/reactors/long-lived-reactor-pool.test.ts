import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { createMcpEventBus } from "@penumbra/daemon/events/mcp-event-bus";
import { createLongLivedReactor } from "@penumbra/daemon/reactors/long-lived-reactor";
import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";

import type {
  FederationHealthSnapshot,
  McpPool,
  McpToolDescriptor,
} from "../../src/long-lived/mcp-pool.js";

type LoggerArg = NonNullable<Parameters<typeof createLongLivedReactor>[0]["log"]>;
type SpawnArg = Parameters<typeof createLongLivedReactor>[0]["spawn"];

function tempDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

interface FakePoolOverrides {
  ensureRunning?: McpPool["ensureRunning"];
  acquire?: McpPool["acquire"];
  release?: McpPool["release"];
  shutdown?: McpPool["shutdown"];
}

function makeFakePool(overrides: FakePoolOverrides = {}): McpPool {
  const empty: FederationHealthSnapshot = { registered: [], skipped: [] };
  const ensureDefault: McpPool["ensureRunning"] = () => Promise.resolve();
  const acquireDefault: McpPool["acquire"] = () => undefined;
  const releaseDefault: McpPool["release"] = () => undefined;
  const shutdownDefault: McpPool["shutdown"] = () => Promise.resolve();
  return {
    ensureRunning: overrides.ensureRunning ?? ensureDefault,
    callTool: (): Promise<unknown> => Promise.resolve(undefined),
    listTools: (): Promise<McpToolDescriptor[]> => Promise.resolve([]),
    acquire: overrides.acquire ?? acquireDefault,
    release: overrides.release ?? releaseDefault,
    getFederationHealth: (): FederationHealthSnapshot => empty,
    shutdown: overrides.shutdown ?? shutdownDefault,
  };
}

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

function fakeSpawn(): SpawnArg {
  return mock((): Promise<{ chain_id: string }> => Promise.resolve({ chain_id: "c1" }));
}

interface HostedSpec {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

describe("long-lived reactor mcp pool bootstrap", () => {
  it("ensures and acquires hosted mcp servers on reload", async () => {
    const db = tempDb();
    const ensureRunning = mock((): Promise<void> => Promise.resolve());
    const acquire = mock((): undefined => undefined);
    const fakePool = makeFakePool({ ensureRunning, acquire });
    const reactor = createLongLivedReactor({
      db,
      bus: createMcpEventBus(),
      spawn: fakeSpawn(),
      isChainActive: () => false,
      now: () => 100,
      log: stubLogger({}),
      mcpPool: fakePool,
      loadAgentchatYaml: () =>
        Promise.resolve({
          agents: [
            {
              name: "home",
              long_lived: true,
              long_lived_config: {
                schedule_cron: "*/5 * * * *",
                subscriptions: [],
                hosted_mcp_servers: [
                  {
                    name: "echo",
                    command: "bun",
                    args: ["run", "echo-mcp.ts"],
                    env: [],
                  },
                ],
                mcp_allowlist: [],
                bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
                circuit_breaker_threshold: 3,
                standing_brief: "x",
              },
            },
          ],
        }),
    });

    await reactor.reload();

    expect(ensureRunning).toHaveBeenCalledTimes(1);
    expect(ensureRunning).toHaveBeenCalledWith({
      name: "echo",
      command: "bun",
      args: ["run", "echo-mcp.ts"],
      env: [],
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith("home", "echo");
  });

  it("releases removed hosted mcp servers and acquires new ones", async () => {
    const db = tempDb();
    const release = mock((): undefined => undefined);
    const ensureRunning = mock((): Promise<void> => Promise.resolve());
    const acquire = mock((): undefined => undefined);
    let hosted: HostedSpec[] = [
      {
        name: "a",
        command: "bun",
        args: ["run", "a.ts"],
        env: [],
      },
    ];
    const fakePool = makeFakePool({ ensureRunning, acquire, release });
    const reactor = createLongLivedReactor({
      db,
      bus: createMcpEventBus(),
      spawn: fakeSpawn(),
      isChainActive: () => false,
      now: () => 100,
      mcpPool: fakePool,
      loadAgentchatYaml: () =>
        Promise.resolve({
          agents: [
            {
              name: "home",
              long_lived: true,
              long_lived_config: {
                subscriptions: [],
                hosted_mcp_servers: hosted,
                mcp_allowlist: [],
                bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
                circuit_breaker_threshold: 3,
                standing_brief: "x",
              },
            },
          ],
        }),
    });

    await reactor.reload();
    hosted = [
      {
        name: "b",
        command: "bun",
        args: ["run", "b.ts"],
        env: [],
      },
    ];
    await reactor.reload();

    expect(release).toHaveBeenCalledWith("home", "a");
    expect(acquire).toHaveBeenCalledWith("home", "b");
  });

  it("continues reloading other hosted mcp servers after one bootstrap failure", async () => {
    const db = tempDb();
    const warn = mock((): undefined => undefined);
    const ensureRunning = mock((spec: { name: string }): Promise<void> => {
      if (spec.name === "bad") return Promise.reject(new Error("boom"));
      return Promise.resolve();
    });
    const acquire = mock((): undefined => undefined);
    const fakePool = makeFakePool({ ensureRunning, acquire });
    const reactor = createLongLivedReactor({
      db,
      bus: createMcpEventBus(),
      spawn: fakeSpawn(),
      isChainActive: () => false,
      now: () => 100,
      log: stubLogger({ warn }),
      mcpPool: fakePool,
      loadAgentchatYaml: () =>
        Promise.resolve({
          agents: [
            {
              name: "home",
              long_lived: true,
              long_lived_config: {
                subscriptions: [],
                hosted_mcp_servers: [
                  {
                    name: "bad",
                    command: "bun",
                    args: ["run", "bad.ts"],
                    env: [],
                  },
                  {
                    name: "good",
                    command: "bun",
                    args: ["run", "good.ts"],
                    env: [],
                  },
                ],
                mcp_allowlist: [],
                bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
                circuit_breaker_threshold: 3,
                standing_brief: "x",
              },
            },
            {
              name: "other",
              long_lived: true,
              long_lived_config: {
                subscriptions: [],
                hosted_mcp_servers: [
                  {
                    name: "other-good",
                    command: "bun",
                    args: ["run", "other-good.ts"],
                    env: [],
                  },
                ],
                mcp_allowlist: [],
                bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
                circuit_breaker_threshold: 3,
                standing_brief: "x",
              },
            },
          ],
        }),
    });

    await reactor.reload();

    expect(ensureRunning).toHaveBeenCalledTimes(3);
    expect(acquire).toHaveBeenCalledWith("home", "good");
    expect(acquire).toHaveBeenCalledWith("other", "other-good");
    expect(warn).toHaveBeenCalledWith(
      {
        agent_id: "home",
        err: "boom",
        server: "bad",
      },
      "mcp-pool-bootstrap-failed",
    );
  });

  it("warns when legacy mcpServers remain without federation", async () => {
    const db = tempDb();
    const warn = mock((): undefined => undefined);
    const fakePool = makeFakePool();
    const reactor = createLongLivedReactor({
      db,
      bus: createMcpEventBus(),
      spawn: fakeSpawn(),
      isChainActive: () => false,
      now: () => 100,
      log: stubLogger({ warn }),
      mcpPool: fakePool,
      loadAgentchatYaml: () =>
        Promise.resolve({
          agents: [agentWithMcpServers("home", [{ name: "other" }, { name: "penumbra" }])],
        }),
    });

    await reactor.reload();

    expect(warn).toHaveBeenCalledWith({
      agent_id: "home",
      mcpServers_non_penumbra: ["other"],
      msg: "long-lived agent uses non-federated MCP servers; action-gate will not enforce on these tools",
    });
  });

  it("shuts down the mcp pool", async () => {
    const db = tempDb();
    const shutdown = mock((): Promise<void> => Promise.resolve());
    const fakePool = makeFakePool({ shutdown });
    const reactor = createLongLivedReactor({
      db,
      bus: createMcpEventBus(),
      spawn: fakeSpawn(),
      isChainActive: () => false,
      now: () => 100,
      log: stubLogger({}),
      mcpPool: fakePool,
      loadAgentchatYaml: () => Promise.resolve({ agents: [] }),
    });

    await reactor.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

type AgentRecord = Awaited<
  ReturnType<Parameters<typeof createLongLivedReactor>[0]["loadAgentchatYaml"]>
>["agents"][number];

function agentWithMcpServers(name: string, mcpServers: { name: string }[]): AgentRecord {
  return {
    name,
    long_lived: true,
    long_lived_config: {
      subscriptions: [],
      hosted_mcp_servers: [],
      mcp_allowlist: [],
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: "x",
    },
    mcpServers,
  };
}
