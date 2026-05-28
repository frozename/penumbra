import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { type AgentDescriptor, isEligible } from "../../src/tasks/eligibility.js";
import type { FileTaskInput } from "../../src/tasks/schema.js";
import { TaskWriter } from "../../src/tasks/writer.js";

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

function baseInput(overrides: Partial<FileTaskInput> = {}): FileTaskInput {
  return {
    prompt: "do the thing",
    created_by_kind: "human",
    created_by_id: "cli",
    ...overrides,
  };
}

describe("isEligible", () => {
  const agent: AgentDescriptor = {
    name: "agent-a",
    tags: ["backend", "review"],
    tier: "oc",
    cost_cents_per_run: 25,
  };

  test("required_tags: all required tags must be present", () => {
    expect(isEligible(agent, { required_tags: ["backend"] })).toBe(true);
    expect(isEligible(agent, { required_tags: ["backend", "review"] })).toBe(true);
    expect(isEligible(agent, { required_tags: ["backend", "frontend"] })).toBe(false);
  });

  test("min_tier: equal and higher pass, lower fails", () => {
    expect(isEligible(agent, { min_tier: "oc" })).toBe(true);
    expect(isEligible(agent, { min_tier: "cheap" })).toBe(true);
    expect(isEligible(agent, { min_tier: "premium" })).toBe(false);
  });

  test("max_cost_cents: lower/equal pass, higher fails", () => {
    expect(isEligible(agent, { max_cost_cents: 30 })).toBe(true);
    expect(isEligible(agent, { max_cost_cents: 25 })).toBe(true);
    expect(isEligible(agent, { max_cost_cents: 20 })).toBe(false);
  });

  test("deny_agents: explicit deny always rejects", () => {
    expect(isEligible(agent, { deny_agents: ["agent-a"] })).toBe(false);
    expect(isEligible(agent, { deny_agents: ["agent-b"] })).toBe(true);
  });

  test("allow_agents: when non-empty, agent must be listed", () => {
    expect(isEligible(agent, { allow_agents: ["agent-a"] })).toBe(true);
    expect(isEligible(agent, { allow_agents: ["agent-b"] })).toBe(false);
  });
});

describe("TaskWriter.list({ eligible_for })", () => {
  let db: Database;
  let writer: TaskWriter;

  beforeEach(() => {
    db = freshDb();
    writer = new TaskWriter(db, {
      now: () => 1_000,
      resolveAgent: (name) => {
        if (name === "agent-a") {
          return {
            name: "agent-a",
            tags: ["backend"],
            tier: "oc",
            cost_cents_per_run: 10,
          };
        }
        return undefined;
      },
    });
  });

  test("excludes tasks where deny_agents includes the agent", () => {
    writer.file(baseInput({ prompt: "allowed" }));
    writer.file(
      baseInput({
        prompt: "denied",
        eligibility: { deny_agents: ["agent-a"] },
      }),
    );

    const rows = writer.list({ eligible_for: "agent-a" });
    expect(rows.map((r) => r.prompt)).toEqual(["allowed"]);
  });

  test("excludes tasks where allow_agents is set without the agent", () => {
    writer.file(baseInput({ prompt: "allowed-open" }));
    writer.file(
      baseInput({
        prompt: "allowed-only-b",
        eligibility: { allow_agents: ["agent-b"] },
      }),
    );

    const rows = writer.list({ eligible_for: "agent-a" });
    expect(rows.map((r) => r.prompt)).toEqual(["allowed-open"]);
  });

  test("honors cooldowns per task id for the same agent", () => {
    const x = writer.file(baseInput({ prompt: "task-x" })).task_id;
    const y = writer.file(baseInput({ prompt: "task-y" })).task_id;
    const cooldowns = new Map<string, Map<string, number>>([
      [x, new Map<string, number>([["agent-a", 2_000]])],
    ]);

    const rows = writer.list({
      eligible_for: "agent-a",
      cooldowns,
    });
    expect(rows.map((r) => r.id)).toEqual([y]);
  });

  test("returns [] when eligible_for agent cannot be resolved", () => {
    writer.file(baseInput({ prompt: "task" }));

    const rows = writer.list({ eligible_for: "unknown-agent" });
    expect(rows).toEqual([]);
  });
});
