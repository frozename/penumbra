import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { EmitCapExceeded, enforceEmitCaps } from "@src/tasks/emit-caps.js";
import type { FileTaskInput } from "@src/tasks/schema.js";
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

function baseInput(overrides: Partial<FileTaskInput> = {}): FileTaskInput {
  return {
    prompt: "do the thing",
    created_by_kind: "agent",
    created_by_id: "agent-a",
    ...overrides,
  };
}

function expectEmitCap(
  fn: () => void,
  expected: { scope: "depth" | "descendants" | "rate"; limit: number; observed: number },
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EmitCapExceeded);
    const cap = error as EmitCapExceeded;
    expect(cap.scope).toBe(expected.scope);
    expect(cap.limit).toBe(expected.limit);
    expect(cap.observed).toBe(expected.observed);
    return;
  }

  throw new Error("expected EmitCapExceeded");
}

describe("enforceEmitCaps direct rules", () => {
  test("descendants cap: counts grandchildren under root, throws when at limit", () => {
    const db = freshDb();
    const now = 1000;
    const writer = new TaskWriter(db, () => now);

    const root = writer.file(baseInput({ created_by_kind: "human" })).task_id;
    const child = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: root }),
    ).task_id;
    const grandchild1 = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: child }),
    ).task_id;
    const grandchild2 = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: child }),
    ).task_id;

    // Verify tree: R <- C <- {G1, G2}
    expect(root).toMatch(/^task_/);
    expect(child).toMatch(/^task_/);
    expect(grandchild1).toMatch(/^task_/);
    expect(grandchild2).toMatch(/^task_/);

    // parent C: depth 2, descendants of root = 3 (C, G1, G2)
    expectEmitCap(
      () => {
        enforceEmitCaps(db, {
          producer_kind: "agent",
          producer_id: "agent-x",
          parent_task_id: child,
          max_descendants_per_root: 3,
          now: () => now,
        });
      },
      { scope: "descendants", limit: 3, observed: 3 },
    );

    // Same with max_descendants_per_root 4: no throw
    expect(() => {
      enforceEmitCaps(db, {
        producer_kind: "agent",
        producer_id: "agent-x",
        parent_task_id: child,
        max_descendants_per_root: 4,
        now: () => now,
      });
    }).not.toThrow();
  });

  test("grandchild parent resolves to root for descendants cap", () => {
    const db = freshDb();
    const now = 1000;
    const writer = new TaskWriter(db, () => now);

    const root = writer.file(baseInput({ created_by_kind: "human" })).task_id;
    const child = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: root }),
    ).task_id;
    const grandchild1 = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: child }),
    ).task_id;
    const grandchild2 = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: child }),
    ).task_id;

    // parent_task_id: grandchild1, max_descendants_per_root: 3
    // root descendants count = 3 (child, grandchild1, grandchild2)
    // grandchild1 depth = 3, within default max 5
    expectEmitCap(
      () => {
        enforceEmitCaps(db, {
          producer_kind: "agent",
          producer_id: "agent-x",
          parent_task_id: grandchild1,
          max_descendants_per_root: 3,
          now: () => now,
        });
      },
      { scope: "descendants", limit: 3, observed: 3 },
    );
  });

  test("max_emit_depth override: depth 2 succeeds, depth 3 throws", () => {
    const db = freshDb();
    const now = 1000;
    const writer = new TaskWriter(db, () => now);

    const root = writer.file(baseInput({ created_by_kind: "human" })).task_id;
    const child = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: root }),
    ).task_id;
    const grandchild1 = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: child }),
    ).task_id;

    // parent R (depth 1) with max_emit_depth 2: 1 > 2 is false -> no throw
    expect(() => {
      enforceEmitCaps(db, {
        producer_kind: "agent",
        producer_id: "agent-x",
        parent_task_id: root,
        max_emit_depth: 2,
        now: () => now,
      });
    }).not.toThrow();

    // parent C (depth 2) with max_emit_depth 2: 2 > 2 is false -> no throw
    expect(() => {
      enforceEmitCaps(db, {
        producer_kind: "agent",
        producer_id: "agent-x",
        parent_task_id: child,
        max_emit_depth: 2,
        now: () => now,
      });
    }).not.toThrow();

    // parent G1 (depth 3) with max_emit_depth 2: 3 > 2 is true -> throw
    expectEmitCap(
      () => {
        enforceEmitCaps(db, {
          producer_kind: "agent",
          producer_id: "agent-x",
          parent_task_id: grandchild1,
          max_emit_depth: 2,
          now: () => now,
        });
      },
      { scope: "depth", limit: 2, observed: 3 },
    );
  });

  test("rate cap: counts only the same producer id", () => {
    const db = freshDb();
    const now = 1000;
    const writer = new TaskWriter(db, () => now);

    // Seed 3 agent rows with created_by_id 'agent-a'
    for (let i = 0; i < 3; i++) {
      writer.file(baseInput({ created_by_id: "agent-a" }));
    }

    // producer 'agent-b' does not throw
    expect(() => {
      enforceEmitCaps(db, {
        producer_kind: "agent",
        producer_id: "agent-b",
        per_agent_max: 3,
        now: () => now,
      });
    }).not.toThrow();

    // producer 'agent-a' throws rate/3/3
    expectEmitCap(
      () => {
        enforceEmitCaps(db, {
          producer_kind: "agent",
          producer_id: "agent-a",
          per_agent_max: 3,
          now: () => now,
        });
      },
      { scope: "rate", limit: 3, observed: 3 },
    );
  });

  test("human-filed rows with the same id do not count toward rate cap", () => {
    const db = freshDb();
    const now = 1000;
    const writer = new TaskWriter(db, () => now);

    // Seed 3 human rows with created_by_id 'agent-a'
    for (let i = 0; i < 3; i++) {
      writer.file(baseInput({ created_by_kind: "human", created_by_id: "agent-a" }));
    }

    // enforceEmitCaps for agent 'agent-a' with per_agent_max 3 and now: () => 1000 does not throw
    expect(() => {
      enforceEmitCaps(db, {
        producer_kind: "agent",
        producer_id: "agent-a",
        per_agent_max: 3,
        now: () => now,
      });
    }).not.toThrow();
  });

  test("rate window start is inclusive", () => {
    const db = freshDb();
    const now = 1000;
    const writer = new TaskWriter(db, () => now);

    // Seed 3 agent rows by 'agent-a' at now=1000
    for (let i = 0; i < 3; i++) {
      writer.file(baseInput({ created_by_id: "agent-a" }));
    }

    // now: () => 1500: windowStart = 1500 - 500 = 1000, rows at 1000 >= 1000 -> 3 rows -> throw
    expectEmitCap(
      () => {
        enforceEmitCaps(db, {
          producer_kind: "agent",
          producer_id: "agent-a",
          per_agent_window_ms: 500,
          per_agent_max: 3,
          now: () => 1500,
        });
      },
      { scope: "rate", limit: 3, observed: 3 },
    );

    // now: () => 1501: windowStart = 1501 - 500 = 1001, rows at 1000 < 1001 -> 0 rows -> no throw
    expect(() => {
      enforceEmitCaps(db, {
        producer_kind: "agent",
        producer_id: "agent-a",
        per_agent_window_ms: 500,
        per_agent_max: 3,
        now: () => 1501,
      });
    }).not.toThrow();
  });

  test("non-agent producers bypass even a zero cap", () => {
    const db = freshDb();
    const now = 1000;
    const writer = new TaskWriter(db, () => now);

    // Seed the tree: R <- C <- G1
    const root = writer.file(baseInput({ created_by_kind: "human" })).task_id;
    const child = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: root }),
    ).task_id;
    const grandchild1 = writer.file(
      baseInput({ created_by_kind: "human", parent_task_id: child }),
    ).task_id;

    // per_agent_max 0, max_emit_depth 0, max_descendants_per_root 0
    // human producer with parent_task_id C: bypasses (producer_kind !== 'agent')
    expect(() => {
      enforceEmitCaps(db, {
        producer_kind: "human",
        producer_id: "human-x",
        parent_task_id: child,
        per_agent_max: 0,
        max_emit_depth: 0,
        max_descendants_per_root: 0,
        now: () => now,
      });
    }).not.toThrow();

    // workflow producer with parent_task_id C: bypasses
    expect(() => {
      enforceEmitCaps(db, {
        producer_kind: "workflow",
        producer_id: "workflow/test",
        parent_task_id: child,
        per_agent_max: 0,
        max_emit_depth: 0,
        max_descendants_per_root: 0,
        now: () => now,
      });
    }).not.toThrow();

    // agent producer with no parent: rate cap 0, 0 >= 0 -> throw
    expectEmitCap(
      () => {
        enforceEmitCaps(db, {
          producer_kind: "agent",
          producer_id: "agent-x",
          per_agent_max: 0,
          max_emit_depth: 0,
          max_descendants_per_root: 0,
          now: () => now,
        });
      },
      { scope: "rate", limit: 0, observed: 0 },
    );
  });

  test("EmitCapExceeded shape", () => {
    const cap = new EmitCapExceeded("rate", 3, 4);

    expect(cap).toBeInstanceOf(Error);
    expect(cap.name).toBe("EmitCapExceeded");
    expect(cap.scope).toBe("rate");
    expect(cap.limit).toBe(3);
    expect(cap.observed).toBe(4);
    expect(cap.message).toBe("emit cap exceeded: scope=rate limit=3 observed=4");
  });
});
