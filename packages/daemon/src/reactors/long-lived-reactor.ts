import type {
  AgentConfig,
  HostedMcpServer,
  LongLivedSubscription,
} from "@penumbra/agentchat/config/types";
import type { Database } from "bun:sqlite";

import { createLogger } from "@penumbra/core";
import { isRetiredLongLivedAgent } from "@penumbra/core/long-lived/retired-agents";

import type { McpEventBus } from "../events/mcp-event-bus.js";
import type { McpPool } from "../long-lived/mcp-pool.js";

import { createCronScheduler, type CronScheduler } from "../long-lived/cron-scheduler.js";
import { runPendingExpiry } from "../long-lived/pending-expiry.js";
import { reconcileLongLivedAgents } from "../long-lived/reconciler.js";
import { runSnapshotPurge } from "../long-lived/snapshot-purge.js";
import {
  createTickGate,
  PENDING_CHAIN_SENTINEL,
  type TickAttempt,
  type TickGateResult,
} from "../long-lived/tick-gate.js";

const defaultLog = createLogger({ component: "daemon:long-lived-reactor", level: "silent" });

export type ReactorSpawn = (req: {
  agent_id: string;
  tick_id: string;
  trigger_kind: TickAttempt["trigger_kind"];
  trigger_payload?: unknown;
}) => Promise<{ chain_id: string }>;

export interface LongLivedReactor {
  reload(): Promise<void>;
  shutdown(): Promise<void>;
  _cronList(): string[];
  _cronTestFire(agent_id: string): void;
  manualTick(agent_id: string): TickGateResult;
  injectedGoalTick(agent_id: string): TickGateResult;
}

/**
 * The Services projection of agentchat.agents narrows AgentConfig to fields
 * relevant outside the long-lived path. The runtime data is the full
 * AgentConfig parsed via AgentConfigSchema; widen here at the daemon's
 * long-lived seam so reconcileLongLivedAgents and registration get the
 * fields they actually need.
 */
/**
 * Daemon-side projection of the parsed AgentConfig long_lived_config block.
 * The reactor only consumes a handful of fields directly; the rest are
 * forwarded through the reconciler via toReconcilerAgents() which widens back
 * to the full schema-typed AgentConfig at the boundary.
 */
interface LongLivedConfigYamlProjection {
  schedule_cron?: string;
  subscriptions?: LongLivedSubscription[];
  hosted_mcp_servers?: HostedMcpServer[];
}

export type LongLivedAgentYamlAgent = {
  name: string;
  long_lived?: boolean;
  long_lived_config?: LongLivedConfigYamlProjection;
  display_name?: string;
  /** Legacy top-level mcpServers list; surfaces a non-federation warning when set. */
  mcpServers?: { name?: string }[];
};

export interface LongLivedReactorDeps {
  db: Database;
  bus: McpEventBus;
  spawn: ReactorSpawn;
  isChainActive: (chain_id: string) => boolean;
  now: () => number;
  mcpPool: McpPool;
  log?: ReturnType<typeof createLogger>;
  loadAgentchatYaml: () => Promise<{ agents: LongLivedAgentYamlAgent[] }>;
  dispatchEventLog?: {
    record(event: {
      handoff_id: string;
      worker_id?: string | null;
      source: "worker" | "daemon";
      kind: string;
      ts: string;
      meta?: Record<string, unknown>;
    }): void;
  };
  notificationOutbox?: {
    enqueue(input: {
      project_id: string | null;
      kind: string;
      reference_id: string;
      summary?: string;
      payload?: Record<string, unknown>;
      created_at: number;
    }): void;
  };
}

type ActiveLongLivedAgent = LongLivedAgentYamlAgent & {
  long_lived_config: LongLivedConfigYamlProjection;
};

function activeAgents(agents: readonly LongLivedAgentYamlAgent[]): ActiveLongLivedAgent[] {
  return agents.filter(
    (agent): agent is ActiveLongLivedAgent =>
      agent.long_lived === true &&
      agent.long_lived_config !== undefined &&
      !isRetiredLongLivedAgent(agent.name),
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-wides the daemon's narrow yaml projection back to AgentConfig[] at the
 * reconciler boundary. The runtime data is parsed AgentConfigSchema data —
 * see serve.ts:loadAgentchatYaml — but Services["agentchatConfig"]["agents"]
 * is a narrower projection that omits long-lived-only fields.
 */
function toReconcilerAgents(agents: readonly ActiveLongLivedAgent[]): readonly AgentConfig[] {
  return agents as unknown as readonly AgentConfig[];
}

interface ReloadHelpers {
  registerAgent(agent: ActiveLongLivedAgent): void;
  reconcileHostedMcp(agent: ActiveLongLivedAgent): Promise<void>;
  releaseRemovedAgentMcp(currentNames: ReadonlySet<string>): void;
  registerSweepers(): void;
  clearCrons(): void;
  clearSubscriptions(): void;
  clearSweepers(): void;
}

async function ensureHostedMcpServer(
  deps: LongLivedReactorDeps,
  log: ReturnType<typeof createLogger>,
  agent: ActiveLongLivedAgent,
  spec: HostedMcpServer,
): Promise<void> {
  try {
    await deps.mcpPool.ensureRunning(spec);
    deps.mcpPool.acquire(agent.name, spec.name);
  } catch (err) {
    log.warn(
      { err: errorMessage(err), agent_id: agent.name, server: spec.name },
      "mcp-pool-bootstrap-failed",
    );
  }
}

function warnIfLegacyMcpServers(
  log: ReturnType<typeof createLogger>,
  agent: ActiveLongLivedAgent,
): void {
  const legacy = agent.mcpServers ?? [];
  const nonPenumbra = legacy.filter((entry) => entry.name !== "penumbra");
  if (nonPenumbra.length === 0) return;
  log.warn({
    agent_id: agent.name,
    mcpServers_non_penumbra: nonPenumbra.map((entry) => entry.name),
    msg: "long-lived agent uses non-federated MCP servers; action-gate will not enforce on these tools",
  });
}

function registerLongLivedSweepers(
  deps: LongLivedReactorDeps,
  log: ReturnType<typeof createLogger>,
  cron: CronScheduler,
  sweeperIds: Map<string, string>,
): void {
  const pendingExpiryKey = "__sweeper_pending_expiry__";
  const prevPendingExpiry = sweeperIds.get(pendingExpiryKey);
  if (prevPendingExpiry) cron.cancel(prevPendingExpiry);
  sweeperIds.set(
    pendingExpiryKey,
    cron.register("0 */1 * * *", () => {
      try {
        runPendingExpiry(deps.db, {
          now: deps.now(),
          dispatchEventLog: deps.dispatchEventLog,
          notificationOutbox: deps.notificationOutbox,
        });
      } catch (err) {
        log.warn({ err: errorMessage(err) }, "long-lived-pending-expiry-sweep-failed");
      }
    }),
  );
  const snapshotPurgeKey = "__sweeper_snapshot_purge__";
  const prevSnapshotPurge = sweeperIds.get(snapshotPurgeKey);
  if (prevSnapshotPurge) cron.cancel(prevSnapshotPurge);
  sweeperIds.set(
    snapshotPurgeKey,
    cron.register("0 3 * * *", () => {
      void runSnapshotPurge({
        db: deps.db,
        now: deps.now(),
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        dryRun: true,
        listSnapshots: (): Promise<[]> => Promise.resolve([]),
        log: (message): void => {
          log.info({ message }, "snapshot purge sweeper");
        },
      });
    }),
  );
}

function createReloadHelpers(
  deps: LongLivedReactorDeps,
  log: ReturnType<typeof createLogger>,
  cron: CronScheduler,
  cronIds: Map<string, string>,
  subscriptionUnsubs: Map<string, () => void>,
  sweeperIds: Map<string, string>,
  hostedMcpByAgent: Map<string, Set<string>>,
  tickGate: ReturnType<typeof createTickGate>,
): ReloadHelpers {
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
  function registerAgent(agent: ActiveLongLivedAgent): void {
    const cfg = agent.long_lived_config;
    if (cfg.schedule_cron !== undefined) {
      const prev = cronIds.get(agent.name);
      if (prev) cron.cancel(prev);
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
  function releaseRemovedAgentMcp(currentNames: ReadonlySet<string>): void {
    for (const [agentName, prevNames] of hostedMcpByAgent) {
      if (currentNames.has(agentName)) continue;
      for (const serverName of prevNames) deps.mcpPool.release(agentName, serverName);
      hostedMcpByAgent.delete(agentName);
    }
  }
  async function reconcileHostedMcp(agent: ActiveLongLivedAgent): Promise<void> {
    const hostedServers = agent.long_lived_config.hosted_mcp_servers ?? [];
    const nextNames = new Set(hostedServers.map((spec) => spec.name));
    const prevNames = hostedMcpByAgent.get(agent.name) ?? new Set<string>();
    for (const name of prevNames) {
      if (!nextNames.has(name)) deps.mcpPool.release(agent.name, name);
    }
    for (const spec of hostedServers) {
      await ensureHostedMcpServer(deps, log, agent, spec);
    }
    hostedMcpByAgent.set(agent.name, nextNames);
    if (hostedServers.length === 0) warnIfLegacyMcpServers(log, agent);
  }
  return {
    registerAgent,
    reconcileHostedMcp,
    releaseRemovedAgentMcp,
    registerSweepers: (): void => {
      registerLongLivedSweepers(deps, log, cron, sweeperIds);
    },
    clearCrons,
    clearSubscriptions,
    clearSweepers,
  };
}

function createSpawningTickGate(
  deps: LongLivedReactorDeps,
  log: ReturnType<typeof createLogger>,
): ReturnType<typeof createTickGate> {
  return createTickGate({
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
          (err: unknown) => {
            log.warn(
              { err, agent_id: attempt.agent_id, tick_id: attempt.tick_id },
              "long-lived tick spawn failed",
            );
            try {
              deps.db
                .query(
                  `UPDATE long_lived_ticks
                     SET completed_at = ?, outcome = 'spawn_failed', error_summary = ?
                     WHERE id = ? AND completed_at IS NULL`,
                )
                .run(deps.now(), errorMessage(err).slice(0, 500), attempt.tick_id);
            } catch (markErr) {
              log.error(
                { err: markErr, agent_id: attempt.agent_id, tick_id: attempt.tick_id },
                "long-lived tick spawn_failed marker update failed",
              );
            }
          },
        );
      return { chain_id: PENDING_CHAIN_SENTINEL, tick_id: attempt.tick_id };
    },
    isChainActive: deps.isChainActive,
    now: deps.now,
  });
}

export function createLongLivedReactor(deps: LongLivedReactorDeps): LongLivedReactor {
  const log = deps.log ?? defaultLog;
  const cron: CronScheduler = createCronScheduler();
  const cronIds = new Map<string, string>();
  const subscriptionUnsubs = new Map<string, () => void>();
  const sweeperIds = new Map<string, string>();
  const hostedMcpByAgent = new Map<string, Set<string>>();
  const tickGate = createSpawningTickGate(deps, log);
  const helpers = createReloadHelpers(
    deps,
    log,
    cron,
    cronIds,
    subscriptionUnsubs,
    sweeperIds,
    hostedMcpByAgent,
    tickGate,
  );
  let reloadChain: Promise<void> = Promise.resolve();

  async function doReload(): Promise<void> {
    const yaml = await deps.loadAgentchatYaml();
    const retiredIds = yaml.agents
      .filter((agent) => isRetiredLongLivedAgent(agent.name))
      .map((agent) => agent.name);
    if (retiredIds.length > 0) {
      log.warn({ agent_ids: retiredIds }, "retired long-lived agents ignored; remove their config");
    }
    const agents = activeAgents(yaml.agents);
    reconcileLongLivedAgents(deps.db, toReconcilerAgents(agents), { now: deps.now() });

    helpers.clearCrons();
    helpers.clearSubscriptions();
    helpers.clearSweepers();

    helpers.releaseRemovedAgentMcp(new Set(agents.map((agent) => agent.name)));
    for (const agent of agents) helpers.registerAgent(agent);
    for (const agent of agents) await helpers.reconcileHostedMcp(agent);
    helpers.registerSweepers();
  }

  function reload(): Promise<void> {
    reloadChain = reloadChain.then(doReload, doReload);
    return reloadChain;
  }

  async function shutdown(): Promise<void> {
    helpers.clearCrons();
    helpers.clearSubscriptions();
    helpers.clearSweepers();
    await deps.mcpPool.shutdown();
    hostedMcpByAgent.clear();
  }

  return {
    reload,
    shutdown,
    _cronList(): string[] {
      return [...cronIds.keys(), ...sweeperIds.keys()];
    },
    _cronTestFire(agent_id: string): void {
      const cronId = cronIds.get(agent_id) ?? sweeperIds.get(agent_id);
      if (!cronId) throw new Error(`Unknown long-lived agent: ${agent_id}`);
      cron.testFire(cronId);
    },
    manualTick(agent_id: string): TickGateResult {
      return tickGate.attempt({ agent_id, trigger_kind: "manual" });
    },
    injectedGoalTick(agent_id: string): TickGateResult {
      return tickGate.attempt({ agent_id, trigger_kind: "injected_goal" });
    },
  };
}
