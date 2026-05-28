import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate } from "@penumbra/core";
import { runMemoryDigest } from "../../src/commands/memory.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

afterEach(() => {
  db.close();
});

interface SeedMemoryInput {
  memory_id: string;
  title: string;
  updated_at: string;
  origin: string;
  slug: string | null;
  hook: string | null;
  project_id: string | null;
  retired_at: string | null;
}

function seedT2Memory(input: SeedMemoryInput): void {
  db.run(
    `
    INSERT INTO t2_memories (
      memory_id, user_id, kind, window_start, window_end, title, body,
      slug, hook, origin, project_id, created_at, updated_at, retired_at
    ) VALUES (
      ?, 'u', 'knowledge', ?, ?, ?, 'body', ?, ?, ?, ?, ?, ?, ?
    )
  `,
    [
      input.memory_id,
      input.updated_at,
      input.updated_at,
      input.title,
      input.slug,
      input.hook,
      input.origin,
      input.project_id,
      input.updated_at,
      input.updated_at,
      input.retired_at,
    ],
  );
}

function runDigest(opts: { maestro?: boolean; limit?: number }): string {
  let printed = "";
  const code = runMemoryDigest({
    storageRoot: "/tmp/unused",
    db,
    print: (line) => {
      printed += line;
    },
    ...opts,
  });
  expect(code).toBe(0);
  return printed;
}

describe("runMemoryDigest", () => {
  test("lists active direct memories with slug and hook, ordered by updated_at desc, and excludes other kinds", () => {
    seedT2Memory({
      memory_id: "m-old",
      title: "Old direct",
      updated_at: "2026-01-01T00:00:00.000Z",
      origin: "direct",
      slug: "old-direct",
      hook: "old hook",
      project_id: "proj-a",
      retired_at: null,
    });
    seedT2Memory({
      memory_id: "m-new",
      title: "New direct",
      updated_at: "2026-01-02T00:00:00.000Z",
      origin: "direct",
      slug: "new-direct",
      hook: "new hook",
      project_id: "proj-b",
      retired_at: null,
    });
    seedT2Memory({
      memory_id: "m-null-slug",
      title: "Null slug",
      updated_at: "2026-01-03T00:00:00.000Z",
      origin: "direct",
      slug: null,
      hook: "hook",
      project_id: null,
      retired_at: null,
    });
    seedT2Memory({
      memory_id: "m-null-hook",
      title: "Null hook",
      updated_at: "2026-01-04T00:00:00.000Z",
      origin: "direct",
      slug: "null-hook",
      hook: null,
      project_id: null,
      retired_at: null,
    });
    seedT2Memory({
      memory_id: "m-retired",
      title: "Retired direct",
      updated_at: "2026-01-05T00:00:00.000Z",
      origin: "direct",
      slug: "retired",
      hook: "should not show",
      project_id: null,
      retired_at: "2026-01-10T00:00:00.000Z",
    });
    seedT2Memory({
      memory_id: "m-nondirect",
      title: "Other origin",
      updated_at: "2026-01-06T00:00:00.000Z",
      origin: "indirect",
      slug: "other-origin",
      hook: "other hook",
      project_id: null,
      retired_at: null,
    });

    const output = runDigest({});
    const lines = output.split("\n").filter(Boolean);
    expect(lines).toEqual([
      "- [New direct](new-direct) — new hook",
      "- [Old direct](old-direct) — old hook",
    ]);
    expect(lines.every((line) => /^- \[.+\]\(.+\) — .+$/.test(line))).toBe(true);
  });

  test("applies maestro restriction to project_id IS NULL", () => {
    seedT2Memory({
      memory_id: "m-maestro-ok",
      title: "Global",
      updated_at: "2026-02-01T00:00:00.000Z",
      origin: "direct",
      slug: "global",
      hook: "global hook",
      project_id: null,
      retired_at: null,
    });
    seedT2Memory({
      memory_id: "m-maestro-skip",
      title: "Project",
      updated_at: "2026-02-02T00:00:00.000Z",
      origin: "direct",
      slug: "projected",
      hook: "project hook",
      project_id: "proj-a",
      retired_at: null,
    });

    const output = runDigest({ maestro: true });
    expect(output.trim()).toBe("- [Global](global) — global hook");
  });

  test("uses a default limit of 200 and drops the oldest extras", () => {
    for (let i = 0; i < 201; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      seedT2Memory({
        memory_id: `m${i}`,
        title: `Entry ${i}`,
        updated_at: ts,
        origin: "direct",
        slug: `entry-${i}`,
        hook: "hook",
        project_id: null,
        retired_at: null,
      });
    }

    const lines = runDigest({}).split("\n").filter(Boolean);
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe("- [Entry 200](entry-200) — hook");
    expect(lines[199]).toBe("- [Entry 1](entry-1) — hook");
    expect(lines.at(-1)).not.toBe("- [Entry 0](entry-0) — hook");
  });

  test("--limit overrides the default cap", () => {
    for (let i = 0; i < 201; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      seedT2Memory({
        memory_id: `lm${i}`,
        title: `Entry ${i}`,
        updated_at: ts,
        origin: "direct",
        slug: `entry-${i}`,
        hook: "hook",
        project_id: null,
        retired_at: null,
      });
    }

    const lines = runDigest({ limit: 5 }).split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);
    expect(lines).toEqual([
      "- [Entry 200](entry-200) — hook",
      "- [Entry 199](entry-199) — hook",
      "- [Entry 198](entry-198) — hook",
      "- [Entry 197](entry-197) — hook",
      "- [Entry 196](entry-196) — hook",
    ]);
  });

  test("prints nothing on empty results and still exits successfully", () => {
    seedT2Memory({
      memory_id: "m-retired-only",
      title: "Retired",
      updated_at: "2026-01-01T00:00:00.000Z",
      origin: "direct",
      slug: "retired",
      hook: "should disappear",
      project_id: null,
      retired_at: "2026-01-02T00:00:00.000Z",
    });
    const output = runDigest({});
    expect(output).toBe("");
  });
});
