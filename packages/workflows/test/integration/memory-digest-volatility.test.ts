import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry, composeRecall, executeWorkflow } from "@src/index.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatSessionMemorySweepSoakResult } from "../../../../scripts/session-memory-sweep-soak.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

async function withEnv<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = previous;
    }
  }
}

function withDigestEnv<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withEnv(
    "PENUMBRA_MEMORY_DIGEST_STATUS_ROWS",
    "5",
    async () =>
      await withEnv("PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS", "10", () =>
        withEnv("PENUMBRA_CC_MEMORY_DIR", dir, fn),
      ),
  );
}

function seedMemory(
  db: Database,
  row: {
    memoryId: string;
    title: string;
    slug: string;
    hook: string;
    updatedAt: string;
    durability?: string | null;
    isEpisodic?: boolean;
  },
): void {
  db.run(
    `INSERT INTO t2_memories (
      memory_id, user_id, kind, window_start, window_end, title, body,
      slug, hook, origin, project_id, created_at, updated_at, retired_at,
      durability, is_episodic
    ) VALUES (
      ?, 'u', 'knowledge', ?, ?, ?, 'body', ?, ?, 'direct', NULL, ?, ?, NULL, ?, ?
    )`,
    [
      row.memoryId,
      row.updatedAt,
      row.updatedAt,
      row.title,
      row.slug,
      row.hook,
      row.updatedAt,
      row.updatedAt,
      row.durability ?? null,
      row.isEpisodic ? 1 : 0,
    ],
  );
}

async function loadWorkflow(
  root: string,
  name: string,
): Promise<NonNullable<ReturnType<Awaited<ReturnType<typeof buildRegistry>>["getEntry"]>>> {
  const workflowDir = join(root, "workflows", name);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(workflowDir, "workflow.ts"),
    readFileSync(join(import.meta.dir, `../../../../plugin/workflows/${name}/workflow.ts`), "utf8"),
  );
  const registry = await buildRegistry({ workflowsDir: join(root, "workflows") });
  expect(registry.errors).toEqual([]);
  const entry = registry.getEntry(name);
  expect(entry).toBeTruthy();
  if (!entry) throw new Error(`workflow ${name} not registered`);
  return entry;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("memory-digest volatility budgets are stable and session sweep is read-only to MEMORY.md", async () => {
  const root = join(tmpdir(), `memory-digest-volatility-${crypto.randomUUID()}`);
  const memoryDir = join(root, "memory");
  let db: Database | null = null;
  try {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    for (let i = 0; i < 30; i += 1) {
      const idx = String(i);
      seedMemory(db, {
        memoryId: `status-${idx}`,
        title: `Status ${idx}`,
        slug: `status-${idx}`,
        hook: `Status hook ${idx}`,
        durability: "volatile",
        isEpisodic: true,
        updatedAt: `2026-06-11T12:00:${idx.padStart(2, "0")}.000Z`,
      });
    }
    for (let i = 0; i < 50; i += 1) {
      const idx = String(i);
      seedMemory(db, {
        memoryId: `pattern-${idx}`,
        title: `Pattern ${idx}`,
        slug: `pattern-${idx}`,
        hook: `Pattern hook ${idx}`,
        durability: "durable",
        updatedAt: `2026-06-11T13:00:${idx.padStart(2, "0")}.000Z`,
      });
    }

    const digestEntry = await loadWorkflow(root, "memory-digest");
    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: root,
      project: "penumbra",
      sources: digestEntry.spec.recall,
      budgetTokens: digestEntry.spec.recall_budget_tokens,
    });
    const liveDb = db;
    const digestCtx = {
      config: {},
      cwd: root,
      storageRoot: root,
      project: "penumbra",
      args: { db },
      db: (): Database => liveDb,
      dispatch: (): Promise<{ conversation_id: string; handoff_id: string }> =>
        Promise.resolve({ conversation_id: "conversation", handoff_id: "handoff" }),
      awaitChain: (): Promise<{
        status: "timeout";
        final_agent: null;
        response_text: null;
      }> => Promise.resolve({ status: "timeout" as const, final_agent: null, response_text: null }),
      fileWrite: (): Promise<string> => Promise.resolve("/tmp/out"),
    };

    await withDigestEnv(memoryDir, async () => {
      const first = await executeWorkflow({
        spec: digestEntry.spec,
        bundle,
        fn: digestEntry.fn,
        storageRoot: root,
        ctx: digestCtx,
      });
      expect(first.outcome).toBe("success");
      expect(first.sessionReminder).toContain(
        "Loaded 15 digest rows. Full digest is in MEMORY.md.",
      );

      const memoryPath = join(memoryDir, "MEMORY.md");
      expect(existsSync(memoryPath)).toBe(true);
      const firstMemory = readFileSync(memoryPath, "utf8");
      expect(firstMemory).toContain("## Recent Status");
      expect(countOccurrences(firstMemory, "- Status ")).toBe(5);
      expect(countOccurrences(firstMemory, "- Pattern ")).toBe(10);

      const second = await executeWorkflow({
        spec: digestEntry.spec,
        bundle,
        fn: digestEntry.fn,
        storageRoot: root,
        ctx: digestCtx,
      });
      expect(second.outcome).toBe("success");
      const secondMemory = readFileSync(memoryPath, "utf8");
      expect(second.sessionReminder).toBe(first.sessionReminder);
      expect(secondMemory).toBe(firstMemory);

      const sweepEntry = await loadWorkflow(root, "session-memory-sweep");
      const sweep = await executeWorkflow({
        spec: { ...sweepEntry.spec, output: [{ kind: "next-session-prompt" as const }] },
        bundle: { byKey: {}, warnings: [] },
        fn: sweepEntry.fn,
        storageRoot: root,
        ctx: {
          config: {},
          cwd: root,
          storageRoot: root,
          project: "penumbra",
          args: { db, session_id: "missing-session", project_id: "penumbra" },
          db: (): Database => liveDb,
          dispatch: (): Promise<{ conversation_id: string; handoff_id: string }> =>
            Promise.resolve({ conversation_id: "conversation", handoff_id: "handoff" }),
          awaitChain: (): Promise<{
            status: "timeout";
            final_agent: null;
            response_text: null;
          }> =>
            Promise.resolve({
              status: "timeout" as const,
              final_agent: null,
              response_text: null,
            }),
          fileWrite: (): Promise<string> => Promise.resolve("/tmp/out"),
        },
      });
      expect(sweep.outcome).toBe("success");
      expect(readFileSync(memoryPath, "utf8")).toBe(firstMemory);
    });
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("session-memory-sweep soak result formatter emits one JSON object", () => {
  expect(
    formatSessionMemorySweepSoakResult({
      session_id: "s1",
      candidate_count: 2,
      has_updates: true,
      near_dup_filtered: false,
      fts_backlinks_found: true,
    }),
  ).toBe(
    '{"session_id":"s1","candidate_count":2,"has_updates":true,"near_dup_filtered":false,"fts_backlinks_found":true}',
  );
});
