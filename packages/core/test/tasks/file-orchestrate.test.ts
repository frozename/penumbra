import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import type { AgentDescriptor } from "@src/tasks/eligibility.js";
import {
  OrchestrateAgentNotMaestroCapable,
  OrchestrateRecursionForbidden,
  OrchestrateRequiresAllowAgents,
} from "@src/tasks/orchestrate-validation.js";
import { TaskWriter } from "@src/tasks/writer.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeResolver(
  entries: Record<string, AgentDescriptor | undefined>,
): (name: string) => AgentDescriptor | undefined {
  return (name) => entries[name];
}

function makeWriter(
  db: Database,
  resolveAgent?: (name: string) => AgentDescriptor | undefined,
): TaskWriter {
  return new TaskWriter(db, { resolveAgent });
}

describe("TaskWriter.file orchestrate validation", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("happy path with bounds persists orchestrate metadata", () => {
    const writer = makeWriter(
      db,
      makeResolver({
        "claude-acp-sonnet": { name: "claude-acp-sonnet", maestro_capable: true },
      }),
    );

    const { task_id } = writer.file({
      prompt: "coordinate the work",
      kind: "orchestrate",
      eligibility: { allow_agents: ["claude-acp-sonnet"] },
      branch_base: "agent/dep-handoff",
      bounds: {
        wall_clock_ms: 1_800_000,
        cost_cents: 200,
        max_sub_dispatches: 10,
      },
      created_by_kind: "human",
      created_by_id: "cli",
    });

    const row = writer.get(task_id);
    expect(row).toMatchObject({
      id: task_id,
      created_by_kind: "human",
      created_by_id: "cli",
      parent_task_id: null,
      kind: "orchestrate",
      priority: "normal",
      prompt: "coordinate the work",
      acceptance_criteria: null,
      expected_artifacts: null,
      eligibility: { allow_agents: ["claude-acp-sonnet"] },
      review_eligibility: null,
      requires_review: false,
      bounds_wall_clock_ms: 1_800_000,
      bounds_cost_cents: 200,
      bounds_max_sub_dispatches: 10,
      bounds_started_at: null,
      branch_base: "agent/dep-handoff",
      status: "pending",
      result_summary: null,
      result_artifacts: null,
      failure_reason: null,
      chain_id: null,
      origin: null,
      project_id: null,
    });
    expect(typeof row.created_at).toBe("number");
    expect(typeof row.updated_at).toBe("number");
  });

  test("happy path without bounds leaves bounds columns null", () => {
    const writer = makeWriter(
      db,
      makeResolver({
        "claude-acp-sonnet": { name: "claude-acp-sonnet", maestro_capable: true },
      }),
    );

    const { task_id } = writer.file({
      prompt: "coordinate the work",
      kind: "orchestrate",
      eligibility: { allow_agents: ["claude-acp-sonnet"] },
      created_by_kind: "human",
      created_by_id: "cli",
    });

    expect(writer.get(task_id)).toMatchObject({
      kind: "orchestrate",
      bounds_wall_clock_ms: null,
      bounds_cost_cents: null,
      bounds_max_sub_dispatches: null,
      bounds_started_at: null,
      branch_base: null,
    });
  });

  test("empty allow_agents rejects and inserts no row", () => {
    const writer = makeWriter(db, makeResolver({}));

    expect(() =>
      writer.file({
        prompt: "coordinate the work",
        kind: "orchestrate",
        eligibility: { allow_agents: [] },
        created_by_kind: "human",
        created_by_id: "cli",
      }),
    ).toThrow(OrchestrateRequiresAllowAgents);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM tasks").get()?.count,
    ).toBe(0);
  });

  test("agent not maestro-capable rejects and inserts no row", () => {
    const writer = makeWriter(
      db,
      makeResolver({
        "claude-acp-sonnet": { name: "claude-acp-sonnet", maestro_capable: false },
      }),
    );

    expect(() =>
      writer.file({
        prompt: "coordinate the work",
        kind: "orchestrate",
        eligibility: { allow_agents: ["claude-acp-sonnet"] },
        created_by_kind: "human",
        created_by_id: "cli",
      }),
    ).toThrow(OrchestrateAgentNotMaestroCapable);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM tasks").get()?.count,
    ).toBe(0);
  });

  test("recursive orchestrate rejects parent orchestrate tasks", () => {
    const writer = makeWriter(
      db,
      makeResolver({
        "claude-acp-sonnet": { name: "claude-acp-sonnet", maestro_capable: true },
      }),
    );

    const parent = writer.file({
      prompt: "parent orchestrate",
      kind: "orchestrate",
      eligibility: { allow_agents: ["claude-acp-sonnet"] },
      created_by_kind: "human",
      created_by_id: "cli",
    });

    expect(() =>
      writer.file({
        prompt: "child orchestrate",
        kind: "orchestrate",
        parent_task_id: parent.task_id,
        eligibility: { allow_agents: ["claude-acp-sonnet"] },
        created_by_kind: "human",
        created_by_id: "cli",
      }),
    ).toThrow(OrchestrateRecursionForbidden);
  });

  test("non-orchestrate kind is unaffected without resolver", () => {
    const writer = makeWriter(db);

    const { task_id } = writer.file({
      prompt: "do regular work",
      kind: "work",
      created_by_kind: "human",
      created_by_id: "cli",
    });

    expect(writer.get(task_id)).toMatchObject({
      kind: "work",
      bounds_wall_clock_ms: null,
      bounds_cost_cents: null,
      bounds_max_sub_dispatches: null,
      bounds_started_at: null,
    });
  });

  test("non-orchestrate kind ignores bounds field", () => {
    const writer = makeWriter(db);

    const { task_id } = writer.file({
      prompt: "do regular work",
      kind: "work",
      bounds: {
        wall_clock_ms: 1_800_000,
        cost_cents: 200,
        max_sub_dispatches: 10,
      },
      created_by_kind: "human",
      created_by_id: "cli",
    });

    expect(writer.get(task_id)).toMatchObject({
      kind: "work",
      bounds_wall_clock_ms: null,
      bounds_cost_cents: null,
      bounds_max_sub_dispatches: null,
      bounds_started_at: null,
    });
  });
});
