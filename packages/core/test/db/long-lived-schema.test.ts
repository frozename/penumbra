import { applySchema, SCHEMA_VERSION } from "@penumbra/core/db/schema";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

function fresh(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  return db;
}

describe("long-lived schema (v15)", () => {
  it("SCHEMA_VERSION is at least 15", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
  });

  it("applySchema creates all five long_lived_* tables", () => {
    const db = fresh();
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'long_lived_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual([
      "long_lived_action_audit",
      "long_lived_agents",
      "long_lived_cooldowns",
      "long_lived_pending_actions",
      "long_lived_ticks",
    ]);
  });

  it("applySchema includes long-lived dispatch identity columns on handoffs", () => {
    const db = fresh();
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info('handoffs')")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("dispatch_kind");
    expect(cols).toContain("long_lived_agent_id");
    expect(cols).toContain("long_lived_tick_id");
  });

  it("long_lived_agents has expected NOT NULL columns", () => {
    const db = fresh();
    const cols = db
      .query<
        { name: string; type: string; notnull: number },
        []
      >("PRAGMA table_info('long_lived_agents')")
      .all();
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.id.type).toBe("TEXT");
    expect(byName.status.notnull).toBe(1);
    expect(byName.consecutive_failures.notnull).toBe(1);
    expect(byName.circuit_breaker_threshold.notnull).toBe(1);
    expect(byName.mcp_allowlist_json.notnull).toBe(1);
    expect(byName.approval_required_globs_json.notnull).toBe(1);
    expect(byName.cooldown_overrides_json.notnull).toBe(1);
    expect(byName.working_memory_json.notnull).toBe(1);
    expect(byName.standing_brief.notnull).toBe(1);
  });

  it("long_lived_agents has a nullable project_id column", () => {
    const db = fresh();
    const row = db
      .query<{ name: string; type: string; notnull: number }, []>(
        "PRAGMA table_info('long_lived_agents')",
      )
      .all()
      .find((column) => column.name === "project_id");
    expect(row).toBeDefined();
    expect(row?.name).toBe("project_id");
    expect(row?.type).toBe("TEXT");
    expect(row?.notnull).toBe(0);
  });

  it("long_lived_agents.project_id column persists and reads back", () => {
    const db = fresh();
    db.query(
      `
      INSERT INTO long_lived_agents (
        id, display_name, working_memory_json, standing_brief, created_at, updated_at, project_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "agent-a",
      "Agent A",
      JSON.stringify({
        version: 1,
        updated_at: 1700000000000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "keep running",
      1700000000000,
      1700000000000,
      "llamactl",
    );

    const row = db
      .query<
        { project_id: string | null },
        [string]
      >("SELECT project_id FROM long_lived_agents WHERE id = ?")
      .get("agent-a");
    expect(row?.project_id).toBe("llamactl");
  });

  it("long_lived_agents.project_id defaults to null when not set", () => {
    const db = fresh();
    db.query(
      `
      INSERT INTO long_lived_agents (
        id, display_name, working_memory_json, standing_brief, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "agent-b",
      "Agent B",
      JSON.stringify({
        version: 1,
        updated_at: 1700000000000,
        pending_goals: [],
        open_threads: [],
        watches: [],
        recent_decisions: [],
      }),
      "watch and report",
      1700000000000,
      1700000000000,
    );

    const row = db
      .query<
        { project_id: string | null },
        [string]
      >("SELECT project_id FROM long_lived_agents WHERE id = ?")
      .get("agent-b");
    expect(row?.project_id).toBeNull();
  });

  it("long_lived_pending_actions includes nullable meta_json for persisted _meta", () => {
    const db = fresh();
    const row = db
      .query<{ name: string; type: string; notnull: number }, []>(
        "PRAGMA table_info('long_lived_pending_actions')",
      )
      .all()
      .find((column) => column.name === "meta_json");
    expect(row).toBeDefined();
    expect(row?.name).toBe("meta_json");
    expect(row?.type).toBe("TEXT");
    expect(row?.notnull).toBe(0);
  });

  it("has the expected indexes", () => {
    const db = fresh();
    const idx = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_long_lived_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(idx).toEqual([
      "idx_long_lived_action_audit_lookup",
      "idx_long_lived_pending_actions_lookup",
      "idx_long_lived_ticks_by_agent",
    ]);
  });

  it("applySchema is idempotent (second call does not throw)", () => {
    const db = fresh();
    expect(() => {
      applySchema(db, { embeddingDim: 384 });
    }).not.toThrow();
  });

  it("long_lived project_id migration is idempotent", () => {
    const db = fresh();
    expect(() => {
      applySchema(db, { embeddingDim: 384 });
    }).not.toThrow();
    const rows = db
      .query<{ name: string }, []>(`PRAGMA table_info('long_lived_agents')`)
      .all()
      .filter((column) => column.name === "project_id");
    expect(rows).toHaveLength(1);
  });
});
