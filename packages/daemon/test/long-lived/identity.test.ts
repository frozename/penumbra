import { loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { verifyRunningIdentity } from "@src/long-lived/identity.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test("verifyRunningIdentity returns true for a running tick", () => {
  const db = makeDb();
  db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, status, degraded_reason, consecutive_failures, circuit_breaker_threshold,
      schedule_cron, subscriptions_json, mcp_allowlist_json, approval_required_globs_json,
      cooldown_overrides_json, bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
      working_memory_json, standing_brief, last_tick_started_at, last_tick_completed_at,
      last_tick_outcome, last_intent_summary, retired_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "agent-1",
    "Agent 1",
    "active",
    null,
    0,
    3,
    null,
    "[]",
    "[]",
    "[]",
    "{}",
    null,
    null,
    null,
    "{}",
    "brief",
    null,
    null,
    null,
    null,
    null,
    1,
    1,
  );
  db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
      completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("tick-1", "agent-1", null, "manual", null, null, 1, null, null, null, null, null);

  expect(verifyRunningIdentity(db, "agent-1", "tick-1")).toBe(true);
});

test("verifyRunningIdentity returns false for a completed tick", () => {
  const db = makeDb();
  db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, status, degraded_reason, consecutive_failures, circuit_breaker_threshold,
      schedule_cron, subscriptions_json, mcp_allowlist_json, approval_required_globs_json,
      cooldown_overrides_json, bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
      working_memory_json, standing_brief, last_tick_started_at, last_tick_completed_at,
      last_tick_outcome, last_intent_summary, retired_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "agent-1",
    "Agent 1",
    "active",
    null,
    0,
    3,
    null,
    "[]",
    "[]",
    "[]",
    "{}",
    null,
    null,
    null,
    "{}",
    "brief",
    null,
    null,
    null,
    null,
    null,
    1,
    1,
  );
  db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
      completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("tick-1", "agent-1", null, "manual", null, null, 1, 2, null, null, null, null);

  expect(verifyRunningIdentity(db, "agent-1", "tick-1")).toBe(false);
});

test("verifyRunningIdentity returns false when the agent does not match", () => {
  const db = makeDb();
  db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, status, degraded_reason, consecutive_failures, circuit_breaker_threshold,
      schedule_cron, subscriptions_json, mcp_allowlist_json, approval_required_globs_json,
      cooldown_overrides_json, bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
      working_memory_json, standing_brief, last_tick_started_at, last_tick_completed_at,
      last_tick_outcome, last_intent_summary, retired_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "agent-1",
    "Agent 1",
    "active",
    null,
    0,
    3,
    null,
    "[]",
    "[]",
    "[]",
    "{}",
    null,
    null,
    null,
    "{}",
    "brief",
    null,
    null,
    null,
    null,
    null,
    1,
    1,
  );
  db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
      completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("tick-1", "agent-1", null, "manual", null, null, 1, null, null, null, null, null);

  expect(verifyRunningIdentity(db, "agent-2", "tick-1")).toBe(false);
});

test("verifyRunningIdentity returns false for an unknown tick", () => {
  const db = makeDb();

  expect(verifyRunningIdentity(db, "agent-1", "missing")).toBe(false);
});
