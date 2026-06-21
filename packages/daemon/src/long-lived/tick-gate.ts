import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export const PENDING_CHAIN_SENTINEL = "pending";

export interface TickAttempt {
  agent_id: string;
  trigger_kind: "cron" | "event" | "injected_goal" | "manual";
  trigger_payload?: unknown;
  debounce_key?: string;
}

export type TickGateOutcome = "spawned" | "skipped_status" | "concurrency_skip" | "debounced";

export interface TickGateResult {
  outcome: TickGateOutcome;
  tick_id?: string;
  chain_id?: string;
}

export interface TickGate {
  attempt(a: TickAttempt): TickGateResult;
}

export interface TickGateDeps {
  db: Database;
  spawn: (a: TickAttempt & { tick_id: string }) => { chain_id: string; tick_id: string };
  isChainActive: (chain_id: string) => boolean;
  now: () => number;
  log?: Pick<Console, "error">;
  debounceWindowMs?: number;
}

function insertTerminalTick(
  db: Database,
  input: {
    tickId: string;
    agentId: string;
    triggerKind: TickAttempt["trigger_kind"];
    triggerPayload?: unknown;
    startedAt: number;
    outcome: "circuit_open" | "concurrency_skip";
  },
): void {
  db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, trigger_payload_json, started_at, completed_at, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.tickId,
    input.agentId,
    input.triggerKind,
    input.triggerPayload === undefined ? null : JSON.stringify(input.triggerPayload),
    input.startedAt,
    input.startedAt,
    input.outcome,
  );
}

export function reconcileOrphanTickRows(db: Database, now: number): number {
  const result = db
    .query(
      `UPDATE long_lived_ticks
     SET completed_at = ?, outcome = 'orphan_recovered',
         error_summary = ?
     WHERE completed_at IS NULL`,
    )
    .run(now, "orphan row detected at worker boot");
  return Number(result.changes ?? 0);
}

type GateDecision =
  | { kind: "no_agent" }
  | { kind: "skipped_status"; tickId: string }
  | { kind: "concurrency_skip"; tickId: string }
  | { kind: "debounced" }
  | { kind: "spawn"; tickId: string; startedAt: number };

export function createTickGate(deps: TickGateDeps): TickGate {
  const debounceWindowMs = deps.debounceWindowMs ?? 1000;
  const lastEventFireAt = new Map<string, number>();

  const decide = deps.db.transaction((a: TickAttempt): GateDecision => {
    const agent = deps.db
      .query<
        { status: string; last_tick_started_at: number | null },
        [string]
      >("SELECT status, last_tick_started_at FROM long_lived_agents WHERE id = ?")
      .get(a.agent_id);
    if (!agent) return { kind: "no_agent" };

    const startedAt = deps.now();

    if (agent.status !== "active") {
      const tickId = randomUUID();
      insertTerminalTick(deps.db, {
        tickId,
        agentId: a.agent_id,
        triggerKind: a.trigger_kind,
        triggerPayload: a.trigger_payload,
        startedAt,
        outcome: "circuit_open",
      });
      return { kind: "skipped_status", tickId };
    }

    const lastChain = deps.db
      .query<
        { chain_id: string | null },
        [string]
      >("SELECT chain_id FROM long_lived_ticks WHERE agent_id=? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1")
      .get(a.agent_id);

    const lastChainId = lastChain?.chain_id ?? null;
    const inFlightUnresolved =
      lastChain !== null && (lastChainId === null || lastChainId === PENDING_CHAIN_SENTINEL);
    const inFlightResolvedActive =
      lastChainId !== null &&
      lastChainId !== PENDING_CHAIN_SENTINEL &&
      deps.isChainActive(lastChainId);
    const recentTickActive =
      agent.last_tick_started_at !== null &&
      startedAt - agent.last_tick_started_at < debounceWindowMs;

    if (inFlightUnresolved || inFlightResolvedActive || recentTickActive) {
      const tickId = randomUUID();
      insertTerminalTick(deps.db, {
        tickId,
        agentId: a.agent_id,
        triggerKind: a.trigger_kind,
        triggerPayload: a.trigger_payload,
        startedAt,
        outcome: "concurrency_skip",
      });
      return { kind: "concurrency_skip", tickId };
    }

    if (lastChainId !== null && lastChainId !== PENDING_CHAIN_SENTINEL) {
      deps.db
        .query(
          `UPDATE long_lived_ticks
           SET completed_at = ?, outcome = 'orphan_recovered',
               error_summary = ?
           WHERE chain_id = ? AND completed_at IS NULL`,
        )
        .run(startedAt, "chain reported inactive at next tick attempt", lastChainId);
    }

    if (a.trigger_kind === "event" && a.debounce_key) {
      const key = `${a.agent_id}::${a.debounce_key}`;
      const lastAt = lastEventFireAt.get(key) ?? -Infinity;
      if (startedAt - lastAt < debounceWindowMs) return { kind: "debounced" };
      lastEventFireAt.set(key, startedAt);
    }

    const tickId = randomUUID();
    deps.db
      .query(
        "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, trigger_payload_json, started_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        tickId,
        a.agent_id,
        a.trigger_kind,
        a.trigger_payload === undefined ? null : JSON.stringify(a.trigger_payload),
        startedAt,
      );

    deps.db
      .query("UPDATE long_lived_agents SET last_tick_started_at=?, updated_at=? WHERE id=?")
      .run(startedAt, startedAt, a.agent_id);

    return { kind: "spawn", tickId, startedAt };
  }).immediate;

  return {
    attempt(a): TickGateResult {
      const decision = decide(a);

      switch (decision.kind) {
        case "no_agent":
          return { outcome: "skipped_status" };
        case "skipped_status":
          return { outcome: "skipped_status", tick_id: decision.tickId };
        case "concurrency_skip":
          return { outcome: "concurrency_skip", tick_id: decision.tickId };
        case "debounced":
          return { outcome: "debounced" };
        case "spawn": {
          const spawned = deps.spawn({ ...a, tick_id: decision.tickId });
          try {
            deps.db
              .query("UPDATE long_lived_ticks SET chain_id=? WHERE id=?")
              .run(spawned.chain_id, decision.tickId);
          } catch (err) {
            deps.log?.error(
              {
                err,
                agent_id: a.agent_id,
                tick_id: decision.tickId,
                chain_id: spawned.chain_id,
              },
              "long-lived tick chain_id update failed",
            );
          }
          return { outcome: "spawned", tick_id: decision.tickId, chain_id: spawned.chain_id };
        }
      }
    },
  };
}
