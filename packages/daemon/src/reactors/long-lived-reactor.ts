import type { Database } from 'bun:sqlite';
import { createLogger } from '@penumbra/core';
import type { McpEventBus } from '../events/mcp-event-bus.js';
import { reconcileLongLivedAgents } from '../long-lived/reconciler.js';
import { createCronScheduler, type CronScheduler } from '../long-lived/cron-scheduler.js';
import { createTickGate, type TickAttempt } from '../long-lived/tick-gate.js';

const log = createLogger({ component: 'daemon:long-lived-reactor', level: 'silent' });

export interface ReactorSpawn {
  (req: {
    agent_id: string;
    tick_id: string;
    trigger_kind: TickAttempt['trigger_kind'];
    trigger_payload?: unknown;
  }): Promise<{ chain_id: string }>;
}

export interface LongLivedReactor {
  reload(): Promise<void>;
  shutdown(): void;
  _cronList(): string[];
  _cronTestFire(agent_id: string): void;
}

export interface LongLivedReactorDeps {
  db: Database;
  bus: McpEventBus;
  spawn: ReactorSpawn;
  isChainActive: (chain_id: string) => boolean;
  now: () => number;
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
  };
};

export function createLongLivedReactor(deps: LongLivedReactorDeps): LongLivedReactor {
  const cron: CronScheduler = createCronScheduler();
  const cronIds = new Map<string, string>();
  const subscriptionUnsubs = new Map<string, () => void>();

  const tickGate = createTickGate({
    db: deps.db,
    spawn: (attempt) => {
      void deps.spawn({
        agent_id: attempt.agent_id,
        tick_id: attempt.tick_id,
        trigger_kind: attempt.trigger_kind,
        trigger_payload: attempt.trigger_payload,
      }).then(
        (result) => {
          deps.db.query('UPDATE long_lived_ticks SET chain_id=? WHERE id=?').run(result.chain_id, attempt.tick_id);
        },
        (err) => {
          log.warn({ err, agent_id: attempt.agent_id, tick_id: attempt.tick_id }, 'long-lived tick spawn failed');
        },
      );
      return { chain_id: 'pending', tick_id: attempt.tick_id };
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

  function activeAgents(agents: readonly AgentRecord[]): AgentRecord[] {
    return agents.filter((agent) => agent.long_lived === true && agent.long_lived_config !== undefined);
  }

  function registerAgent(agent: AgentRecord): void {
    const cfg = agent.long_lived_config!;
    if (cfg.schedule_cron) {
      const cronId = cron.register(cfg.schedule_cron, () => {
        tickGate.attempt({ agent_id: agent.name, trigger_kind: 'cron' });
      });
      cronIds.set(agent.name, cronId);
    }

    for (const sub of cfg.subscriptions ?? []) {
      const key = `${agent.name}::${sub.server}::${sub.event}`;
      const unsub = deps.bus.subscribe(sub, (evt) => {
        tickGate.attempt({
          agent_id: agent.name,
          trigger_kind: 'event',
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

      for (const agent of agents) registerAgent(agent);
    },

    shutdown() {
      clearCrons();
      clearSubscriptions();
    },

    _cronList() {
      return Array.from(cronIds.keys());
    },

    _cronTestFire(agent_id: string) {
      const cronId = cronIds.get(agent_id);
      if (!cronId) throw new Error(`Unknown long-lived agent: ${agent_id}`);
      cron.testFire(cronId);
    },
  };
}
