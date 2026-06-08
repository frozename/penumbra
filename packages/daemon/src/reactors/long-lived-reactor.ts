import type { Database } from "bun:sqlite";
import { createLogger } from "@penumbra/core";
import type { McpEventBus } from "../events/mcp-event-bus.js";
import { reconcileLongLivedAgents } from "../long-lived/reconciler.js";
import { createCronScheduler, type CronScheduler } from "../long-lived/cron-scheduler.js";
import { createTickGate, type TickAttempt, type TickGateResult } from "../long-lived/tick-gate.js";
import { runPendingExpiry } from "../long-lived/pending-expiry.js";
import { runSnapshotPurge } from "../long-lived/snapshot-purge.js";
import type { McpPool } from "../long-lived/mcp-pool.js";
import type { HostedMcpServer } from "@penumbra/agentchat/config/types";

const defaultLog = createLogger({ component: "daemon:long-lived-reactor", level: "silent" });

export interface ReactorSpawn {
  (req: {
    agent_id: string;
    tick_id: string;
    trigger_kind: TickAttempt["trigger_kind"];
    trigger_payload?: unknown;
  }): Promise<{ chain_id: string }>;
}

export interface LongLivedReactor {
  reload(): Promise<void>;
  shutdown(): Promise<void>;
  _cronList(): string[];
  _cronTestFire(agent_id: string): void;
  manualTick(agent_id: string): TickGateResult;
}

export interface LongLivedReactorDeps {
  db: Database;
  bus: McpEventBus;
  spawn: ReactorSpawn;
  isChainActive: (chain_id: string) => boolean;
  now: () => number;
  mcpPool: McpPool;
  log?: ReturnType<typeof createLogger>;
  loadAgentchatYaml: () => Promise<{
    agents: Array<{
      name: string;
      long_lived?: boolean;
      long_lived_config?: any;
      display_name?: string;
    }>;
  }>;
}

type AgentRecord = {
  name: string;
  long_lived?: boolean;
  long_lived_config?: {
    schedule_cron?: string;
    subscriptions?: Array<{ server: string; event: string }>;
    hosted_mcp_servers?: HostedMcpServer[];
  };
};

export function createLongLivedReactor(deps: LongLivedReactorDeps): LongLivedReactor {
  const log = deps.log ?? defaultLog;
  const cron: CronScheduler = createCronScheduler();
  const cronIds = new Map<string, string>();
  const subscriptionUnsubs = new Map<string, () => void>();
  const sweeperIds = new Map<string, string>();
  const hostedMcpByAgent = new Map<string, Set<string>>();

  const tickGate = createTickGate({
    db: deps.db,
    log,
    spawn: (attempt) => {
      void deps
        .spawn({
          agent_id: attempt.agent_id,
          tick_id: attempt.tick_id,
          trigger_kind: attempt.trigger_kind,
          trigger_payload: attempt.trigger_payload,
        })
        .then(
          (result) => {
            try {
              deps.db
                .query("UPDATE long_lived_ticks SET chain_id=? WHERE id=?")
                .run(result.chain_id, attempt.tick_id);
            } catch (err) {
              log.error(
                {
                  err,
                  agent_id: attempt.agent_id,
                  tick_id: attempt.tick_id,
                  chain_id: result.chain_id,
                },
                "long-lived tick chain_id update failed",
              );
            }
          },
          (err) => {
            log.warn(
              { err, agent_id: attempt.agent_id, tick_id: attempt.tick_id },
              "long-lived tick spawn failed",
            );
          },
        );
      return { chain_id: "pending", tick_id: attempt.tick_id };
    },
    isChainActive: deps.isChainActive,
    now: deps.now,
  });

  function clearCrons(): void {
    for (const id of cronIds.values()) cron.cancel(id);
    cronIds.clear();
  }

  function clearSubscriptions(): void {
    for (const unsub of subscriptionUnsubs.values()) unsub();
    subscriptionUnsubs.clear();
  }

  function clearSweepers(): void {
    for (const id of sweeperIds.values()) cron.cancel(id);
    sweeperIds.clear();
  }

  function activeAgents(agents: readonly AgentRecord[]): AgentRecord[] {
    return agents.filter(
      (agent) => agent.long_lived === true && agent.long_lived_config !== undefined,
    );
  }

  function registerAgent(agent: AgentRecord): void {
    const cfg = agent.long_lived_config!;
    if (cfg.schedule_cron) {
      const cronId = cron.register(cfg.schedule_cron, () => {
        tickGate.attempt({ agent_id: agent.name, trigger_kind: "cron" });
      });
      cronIds.set(agent.name, cronId);
    }

    for (const sub of cfg.subscriptions ?? []) {
      const key = `${agent.name}::${sub.server}::${sub.event}`;
      const unsub = deps.bus.subscribe(sub, (evt) => {
        tickGate.attempt({
          agent_id: agent.name,
          trigger_kind: "event",
          trigger_payload: evt,
          debounce_key: `${sub.server}::${sub.event}`,
        });
      });
      subscriptionUnsubs.set(key, unsub);
    }
  }

  return {
    async reload() {
      const yaml = await deps.loadAgentchatYaml();
      const agents = activeAgents(yaml.agents as AgentRecord[]);
      reconcileLongLivedAgents(deps.db, agents as any, { now: deps.now() });

      clearCrons();
      clearSubscriptions();
      clearSweepers();

      const nextAgentNames = new Set(agents.map((agent) => agent.name));
      for (const [agentName, prevNames] of hostedMcpByAgent) {
        if (nextAgentNames.has(agentName)) continue;
        for (const serverName of prevNames) deps.mcpPool.release(agentName, serverName);
        hostedMcpByAgent.delete(agentName);
      }

      for (const agent of agents) registerAgent(agent);

      for (const agent of agents) {
        const hostedServers = agent.long_lived_config?.hosted_mcp_servers ?? [];
        const nextNames = new Set(hostedServers.map((spec) => spec.name));
        const prevNames = hostedMcpByAgent.get(agent.name) ?? new Set<string>();
        for (const name of prevNames) {
          if (!nextNames.has(name)) deps.mcpPool.release(agent.name, name);
        }
        for (const spec of hostedServers) {
          try {
            await deps.mcpPool.ensureRunning(spec);
            deps.mcpPool.acquire(agent.name, spec.name);
          } catch (err) {
            log.warn(
              {
                err: String((err as Error)?.message ?? err),
                agent_id: agent.name,
                server: spec.name,
              },
              "mcp-pool-bootstrap-failed",
            );
          }
        }
        hostedMcpByAgent.set(agent.name, nextNames);
        if ((agent.long_lived_config?.hosted_mcp_servers ?? []).length === 0) {
          const nonPenumbra = (
            ((agent as any).mcpServers ?? []) as Array<{ name?: string }>
          ).filter((mcpServer) => mcpServer.name !== "penumbra");
          if (nonPenumbra.length > 0) {
            log.warn({
              agent_id: agent.name,
              mcpServers_non_penumbra: nonPenumbra.map((mcpServer) => mcpServer.name),
              msg: "long-lived agent uses non-federated MCP servers; action-gate will not enforce on these tools",
            });
          }
        }
      }

      sweeperIds.set(
        "__sweeper_pending_expiry__",
        cron.register("0 */1 * * *", () => {
          runPendingExpiry(deps.db, { now: deps.now() });
        }),
      );
      sweeperIds.set(
        "__sweeper_snapshot_purge__",
        cron.register("0 3 * * *", () => {
          void runSnapshotPurge({
            db: deps.db,
            now: deps.now(),
            ttlMs: 7 * 24 * 60 * 60 * 1000,
            dryRun: true,
            listSnapshots: async () => [],
            log: (message) => log.info({ message }, "snapshot purge sweeper"),
          });
        }),
      );
    },

    async shutdown() {
      clearCrons();
      clearSubscriptions();
      clearSweepers();
      await deps.mcpPool.shutdown();
      hostedMcpByAgent.clear();
    },

    _cronList() {
      return [...cronIds.keys(), ...sweeperIds.keys()];
    },

    _cronTestFire(agent_id: string) {
      const cronId = cronIds.get(agent_id) ?? sweeperIds.get(agent_id);
      if (!cronId) throw new Error(`Unknown long-lived agent: ${agent_id}`);
      cron.testFire(cronId);
    },

    manualTick(agent_id: string): TickGateResult {
      return tickGate.attempt({ agent_id, trigger_kind: "manual" });
    },
  };
}
