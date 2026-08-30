import { loadSqliteVec, migrate } from "@penumbra/core";
import { runMemoryDigest } from "@src/commands/memory.js";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* sqlite already loaded in this process */
}

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
  durability?: string | null;
  is_episodic?: boolean;
  obs_type?: string | null;
}

function seedT2Memory(input: SeedMemoryInput): void {
  db.run(
    `
    INSERT INTO t2_memories (
      memory_id, user_id, kind, window_start, window_end, title, body,
      slug, hook, origin, project_id, created_at, updated_at, retired_at, durability, is_episodic, obs_type
    ) VALUES (
      ?, 'u', 'knowledge', ?, ?, ?, 'body', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      input.durability ?? null,
      input.is_episodic ? 1 : 0,
      input.obs_type ?? null,
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

type DigestEnvName =
  | "PENUMBRA_MEMORY_DIGEST_MAX_LINES"
  | "PENUMBRA_MEMORY_DIGEST_STATUS_ROWS"
  | "PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS";

function withDigestEnv(
  overrides: Partial<Record<DigestEnvName, string | undefined>>,
  fn: () => void,
): void {
  const names: DigestEnvName[] = [
    "PENUMBRA_MEMORY_DIGEST_MAX_LINES",
    "PENUMBRA_MEMORY_DIGEST_STATUS_ROWS",
    "PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  try {
    for (const name of names) {
      if (!(name in overrides)) continue;
      const value = overrides[name];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
    fn();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }
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
        memory_id: `m${String(i)}`,
        title: `Entry ${String(i)}`,
        updated_at: ts,
        origin: "direct",
        slug: `entry-${String(i)}`,
        hook: "hook",
        project_id: null,
        retired_at: null,
      });
    }

    withDigestEnv(
      {
        PENUMBRA_MEMORY_DIGEST_MAX_LINES: undefined,
        PENUMBRA_MEMORY_DIGEST_STATUS_ROWS: undefined,
        PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS: undefined,
      },
      () => {
        const lines = runDigest({}).split("\n").filter(Boolean);
        expect(lines).toHaveLength(200);
        expect(lines[0]).toBe("- [Entry 200](entry-200) — hook");
        expect(lines[199]).toBe("- [Entry 1](entry-1) — hook");
        expect(lines.at(-1)).not.toBe("- [Entry 0](entry-0) — hook");
      },
    );
  });

  test("--limit overrides the default cap", () => {
    for (let i = 0; i < 201; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      seedT2Memory({
        memory_id: `lm${String(i)}`,
        title: `Entry ${String(i)}`,
        updated_at: ts,
        origin: "direct",
        slug: `entry-${String(i)}`,
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

  test("uses PENUMBRA_MEMORY_DIGEST_MAX_LINES as the outer cap when --limit is omitted", () => {
    for (let i = 0; i < 5; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      seedT2Memory({
        memory_id: `em${String(i)}`,
        title: `Entry ${String(i)}`,
        updated_at: ts,
        origin: "direct",
        slug: `entry-${String(i)}`,
        hook: "hook",
        project_id: null,
        retired_at: null,
      });
    }

    withDigestEnv(
      {
        PENUMBRA_MEMORY_DIGEST_MAX_LINES: "3",
        PENUMBRA_MEMORY_DIGEST_STATUS_ROWS: undefined,
        PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS: undefined,
      },
      () => {
        const lines = runDigest({}).split("\n").filter(Boolean);
        expect(lines).toEqual([
          "- [Entry 4](entry-4) — hook",
          "- [Entry 3](entry-3) — hook",
          "- [Entry 2](entry-2) — hook",
        ]);
      },
    );
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

  test("splits volatile status rows ahead of durable pattern rows", () => {
    seedT2Memory({
      memory_id: "m-volatile-new",
      title: "Volatile new",
      updated_at: "2026-03-04T00:00:00.000Z",
      origin: "direct",
      slug: "volatile-new",
      hook: "volatile new hook",
      project_id: null,
      retired_at: null,
      durability: "volatile",
    });
    seedT2Memory({
      memory_id: "m-durable-newer",
      title: "Durable newer",
      updated_at: "2026-03-05T00:00:00.000Z",
      origin: "direct",
      slug: "durable-newer",
      hook: "durable newer hook",
      project_id: null,
      retired_at: null,
      durability: "durable",
    });
    seedT2Memory({
      memory_id: "m-episodic",
      title: "Episodic",
      updated_at: "2026-03-03T00:00:00.000Z",
      origin: "direct",
      slug: "episodic",
      hook: "episodic hook",
      project_id: null,
      retired_at: null,
      is_episodic: true,
    });
    seedT2Memory({
      memory_id: "m-session",
      title: "Session",
      updated_at: "2026-03-02T00:00:00.000Z",
      origin: "direct",
      slug: "session",
      hook: "session hook",
      project_id: null,
      retired_at: null,
      obs_type: "session",
    });

    withDigestEnv(
      {
        PENUMBRA_MEMORY_DIGEST_MAX_LINES: undefined,
        PENUMBRA_MEMORY_DIGEST_STATUS_ROWS: "3",
        PENUMBRA_MEMORY_DIGEST_PATTERN_ROWS: "10",
      },
      () => {
        const lines = runDigest({}).split("\n").filter(Boolean);
        const statusIndex = lines.indexOf("## Recent Status");

        expect(statusIndex).toBeGreaterThanOrEqual(0);
        expect(lines.slice(statusIndex + 1, statusIndex + 4)).toEqual([
          "- [Volatile new](volatile-new) — volatile new hook",
          "- [Episodic](episodic) — episodic hook",
          "- [Session](session) — session hook",
        ]);
        expect(lines.slice(statusIndex + 1, statusIndex + 4)).not.toContain(
          "- [Durable newer](durable-newer) — durable newer hook",
        );
        expect(lines.slice(statusIndex + 4)).toContain(
          "- [Durable newer](durable-newer) — durable newer hook",
        );
      },
    );
  });
});
