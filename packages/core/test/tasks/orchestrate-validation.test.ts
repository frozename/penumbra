import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import type { AgentDescriptor } from "../../src/tasks/eligibility.js";
import type { FileTaskInput } from "../../src/tasks/schema.js";
import {
  OrchestrateAgentNotMaestroCapable,
  OrchestrateRecursionForbidden,
  OrchestrateRequiresAllowAgents,
  validateOrchestrateFile,
} from "../../src/tasks/orchestrate-validation.js";
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
    prompt: "file orchestrate task",
    created_by_kind: "human",
    created_by_id: "cli",
    ...overrides,
  };
}

function makeResolver(
  entries: Record<string, AgentDescriptor | undefined>,
): (name: string) => AgentDescriptor | undefined {
  return (name) => entries[name];
}

function insertTask(
  db: Database,
  kind: "work" | "orchestrate",
  parent_task_id: string | null = null,
): string {
  const taskId = `task_${crypto.randomUUID().toLowerCase()}`;
  const now = Date.now();
  db.run(
    `INSERT INTO tasks (
      id, created_at, updated_at, created_by_kind, created_by_id,
      parent_task_id, kind, priority, prompt, acceptance_criteria,
      expected_artifacts, eligibility, review_eligibility, requires_review,
      status, result_summary, result_artifacts, failure_reason, chain_id, origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', ?, NULL, NULL, ?, NULL, 0, 'pending', NULL, NULL, NULL, NULL, NULL)`,
    [taskId, now, now, "human", "cli", parent_task_id, kind, `seed ${kind}`, JSON.stringify({})],
  );
  return taskId;
}

describe("validateOrchestrateFile", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("non-orchestrate kind is no-op", () => {
    const parentId = insertTask(db, "orchestrate");
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "work",
          parent_task_id: parentId,
        }),
        { resolveAgent: () => undefined },
      ),
    ).not.toThrow();
  });

  test("empty allow_agents throws", () => {
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "orchestrate",
          eligibility: { allow_agents: [] },
        }),
        { resolveAgent: () => undefined },
      ),
    ).toThrow(OrchestrateRequiresAllowAgents);
  });

  test("missing eligibility throws", () => {
    expect(() =>
      validateOrchestrateFile(db, baseInput({ kind: "orchestrate" }), {
        resolveAgent: () => undefined,
      }),
    ).toThrow(OrchestrateRequiresAllowAgents);
  });

  test("unknown agent throws with unknown reason", () => {
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "orchestrate",
          eligibility: { allow_agents: ["foo"] },
        }),
        { resolveAgent: makeResolver({}) },
      ),
    ).toThrow(new OrchestrateAgentNotMaestroCapable("foo", "unknown"));
  });

  test("agent not maestro-capable throws with not_maestro_capable reason", () => {
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "orchestrate",
          eligibility: { allow_agents: ["foo"] },
        }),
        { resolveAgent: makeResolver({ foo: { name: "foo", maestro_capable: false } }) },
      ),
    ).toThrow(new OrchestrateAgentNotMaestroCapable("foo", "not_maestro_capable"));
  });

  test("mixed allow_agents fails on first not-capable entry", () => {
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "orchestrate",
          eligibility: { allow_agents: ["good", "bad"] },
        }),
        {
          resolveAgent: makeResolver({
            good: { name: "good", maestro_capable: true },
            bad: { name: "bad", maestro_capable: false },
          }),
        },
      ),
    ).toThrow(new OrchestrateAgentNotMaestroCapable("bad", "not_maestro_capable"));
  });

  test("happy path passes without parent", () => {
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "orchestrate",
          eligibility: { allow_agents: ["good", "also-good"] },
        }),
        {
          resolveAgent: makeResolver({
            good: { name: "good", maestro_capable: true },
            "also-good": { name: "also-good", maestro_capable: true },
          }),
        },
      ),
    ).not.toThrow();
  });

  test("branch_base is accepted on orchestrate tasks", () => {
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "orchestrate",
          branch_base: "agent/handoff-1",
          eligibility: { allow_agents: ["good"] },
        } as any),
        { resolveAgent: makeResolver({ good: { name: "good", maestro_capable: true } }) },
      ),
    ).not.toThrow();
  });

  test("parent orchestrate is forbidden", () => {
    const parentId = insertTask(db, "orchestrate");
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "orchestrate",
          parent_task_id: parentId,
          eligibility: { allow_agents: ["good"] },
        }),
        { resolveAgent: makeResolver({ good: { name: "good", maestro_capable: true } }) },
      ),
    ).toThrow(new OrchestrateRecursionForbidden(parentId));
  });

  test("parent work does not trigger recursion check", () => {
    const parentId = insertTask(db, "work");
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "orchestrate",
          parent_task_id: parentId,
          eligibility: { allow_agents: ["good"] },
        }),
        { resolveAgent: makeResolver({ good: { name: "good", maestro_capable: true } }) },
      ),
    ).not.toThrow();
  });

  test("missing parent does not throw", () => {
    expect(() =>
      validateOrchestrateFile(
        db,
        baseInput({
          kind: "orchestrate",
          parent_task_id: "task_missing",
          eligibility: { allow_agents: ["good"] },
        }),
        { resolveAgent: makeResolver({ good: { name: "good", maestro_capable: true } }) },
      ),
    ).not.toThrow();
  });
});
