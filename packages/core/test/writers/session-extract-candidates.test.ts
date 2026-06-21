import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import type { T2MemoryExtraction } from "../../src/writers/t2.js";

import { loadSqliteVec, migrate } from "../../src/index.js";
import {
  extractSessionCandidates,
  type SessionExtractCandidate,
} from "../../src/writers/session-extract.js";
import { buildT2EmbedText } from "../../src/writers/t2-embed-text.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

class DeterministicEmbedder {
  readonly name = "deterministic";
  readonly dim = 4;

  constructor(private readonly vectors = new Map<string, Float32Array>()) {}

  embed(input: string[]): Promise<Float32Array[]> {
    return Promise.resolve(
      input.map((text) => this.vectors.get(text) ?? new Float32Array([0, 1, 0, 0])),
    );
  }
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 4 });
});

function seedT2(input: {
  memory_id: string;
  title: string;
  body: string;
  slug?: string | null;
  project_id?: string | null;
  why?: string | null;
  depth?: number | null;
  embedding?: Float32Array;
}): void {
  const now = "2026-06-11T12:00:00.000Z";
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at, slug, why, depth
    ) VALUES(?, ?, 'u1', 'fact', '[]', ?, ?, ?, ?, '{}', NULL, ?, ?, ?, ?, ?)`,
    [
      input.memory_id,
      input.project_id ?? null,
      now,
      now,
      input.title,
      input.body,
      now,
      now,
      input.slug ?? null,
      input.why ?? null,
      input.depth ?? null,
    ],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id = ?")
    .get(input.memory_id)!.rowid;
  db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [
    rowid,
    input.embedding ?? new Float32Array([1, 0, 0, 0]),
  ]);
}

describe("extractSessionCandidates", () => {
  test("empty and short transcripts return no candidates without calling the judge", async () => {
    let calls = 0;
    const opts = {
      db,
      project_id: "proj",
      embedder: new DeterministicEmbedder(),
      llm: (): Promise<T2MemoryExtraction[]> => {
        calls += 1;
        return Promise.resolve([
          {
            title: "Should not run",
            body: "This durable memory body should never be considered by the short transcript gate.",
            kind: "fact",
            why: "The judge should not be called for empty or short transcripts.",
            depth: 2,
          },
        ]);
      },
    };

    expect(await extractSessionCandidates(opts, "")).toEqual([]);
    expect(await extractSessionCandidates(opts, "User: too short")).toEqual([]);
    expect(calls).toBe(0);
  });

  test("slug-matched existing memory yields an update candidate", async () => {
    const title = "Session Extract Existing Rule";
    const body =
      "Session extract should update existing slug rows when the candidate title normalizes to a stored direct-memory slug.";
    seedT2({
      memory_id: "m-existing",
      title,
      body: "Older body for the same durable rule.",
      slug: "session-extract-existing-rule",
      project_id: "proj",
    });

    const candidates = await extractSessionCandidates(
      {
        db,
        project_id: "proj",
        embedder: new DeterministicEmbedder(),
        llm: () =>
          Promise.resolve([
            {
              title,
              body,
              kind: "decision",
              why: "The extracted rule replaces an existing direct memory instead of duplicating it.",
              source_quote: "update the existing row",
              depth: 2,
            },
          ]),
      },
      "User: ".repeat(60),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject<Partial<SessionExtractCandidate>>({
      action: "update",
      slug: "session-extract-existing-rule",
      update_existing_slug: "session-extract-existing-rule",
      existing_memory_id: "m-existing",
      title,
      body,
    });
  });

  test("filters candidates missing why, with short why, or without a durable hook", async () => {
    const validBody =
      "Use the session extract route when the transcript contains durable workflow rules because it preserves update intent.";

    const candidates = await extractSessionCandidates(
      {
        db,
        project_id: "proj",
        embedder: new DeterministicEmbedder(),
        llm: () =>
          Promise.resolve([
            {
              title: "Missing why",
              body: "A body with enough length that would otherwise pass the density gate but lacks explanatory why.",
              kind: "fact",
              why: null,
              depth: 2,
            },
            {
              title: "Short why",
              body: "A body with enough length that would otherwise pass the density gate but has weak why.",
              kind: "fact",
              why: "too short",
              depth: 2,
            },
            {
              title: "Bare fact",
              body: "The file packages/core/src/writers/t2.ts exists in the repository and contains TypeScript code.",
              kind: "fact",
              why: "This has a long enough why but the candidate is still only a bare rediscoverable fact.",
              depth: 2,
            },
            {
              title: "Valid durable rule",
              body: validBody,
              kind: "knowledge",
              why: "The body explains when to use the route and the durable consequence for future sessions.",
              depth: 2,
            },
          ]),
      },
      "Assistant: ".repeat(60),
    );

    expect(candidates.map((c) => c.title)).toEqual(["Valid durable rule"]);
    expect(candidates[0]?.body).toBe(validBody);
  });

  test("filters short shallow bodies", async () => {
    const candidates = await extractSessionCandidates(
      {
        db,
        project_id: "proj",
        embedder: new DeterministicEmbedder(),
        llm: () =>
          Promise.resolve([
            {
              title: "Too short",
              body: "Short durable body.",
              kind: "fact",
              why: "Even with a why, shallow short bodies should not become t2 candidates.",
              depth: 1,
            },
            {
              title: "Deep short",
              body: "Short but deep.",
              kind: "decision",
              why: "Depth two is the existing escape hatch for concise high-value durable items.",
              depth: 2,
            },
          ]),
      },
      "Assistant: ".repeat(60),
    );

    expect(candidates.map((c) => c.title)).toEqual(["Deep short"]);
  });

  test("resolves up to three backlinks from title keywords", async () => {
    for (const [memory_id, title, slug] of [
      ["m-1", "Memory Session Extract Planning", "memory-session-extract-planning"],
      ["m-2", "Memory Session Extract Routing", "memory-session-extract-routing"],
      ["m-3", "Memory Session Extract Quality", "memory-session-extract-quality"],
      ["m-4", "Memory Session Extract Overflow", "memory-session-extract-overflow"],
    ] as const) {
      seedT2({
        memory_id,
        title,
        slug,
        body: `Existing durable context for ${title} with enough searchable body content.`,
        project_id: "proj",
      });
    }

    const candidates = await extractSessionCandidates(
      {
        db,
        project_id: "proj",
        embedder: new DeterministicEmbedder(),
        llm: () =>
          Promise.resolve([
            {
              title: "Memory Session Extract Route",
              body: "Memory session extract candidates should link nearby planning and routing memories because follow-up sessions need context.",
              kind: "knowledge",
              why: "Backlinks give future promotion review enough context to update related durable memories.",
              depth: 2,
            },
          ]),
      },
      "Assistant: ".repeat(60),
    );

    expect(candidates[0]?.backlinks).toHaveLength(3);
    expect(candidates[0]?.backlinks).toContain("m-1");
  });

  test("near-duplicate existing winner becomes an update candidate", async () => {
    const body =
      "Near duplicate session extract candidate with explicit why should update stronger existing memory instead of creating another row.";
    const embedText = buildT2EmbedText("Near Duplicate Rule", body);
    seedT2({
      memory_id: "m-near",
      title: "Near Duplicate Rule Existing",
      slug: "near-duplicate-rule-existing",
      body,
      project_id: "proj",
      why: "Existing row has equal quality and should win ties in near duplicate scoring.",
      depth: 2,
      embedding: new Float32Array([1, 0, 0, 0]),
    });

    const candidates = await extractSessionCandidates(
      {
        db,
        project_id: "proj",
        embedder: new DeterministicEmbedder(new Map([[embedText, new Float32Array([1, 0, 0, 0])]])),
        llm: () =>
          Promise.resolve([
            {
              title: "Near Duplicate Rule",
              body,
              kind: "knowledge",
              why: "Session extraction should reuse near-duplicate rows when the existing memory is stronger.",
              depth: 2,
            },
          ]),
        nearDuplicateThreshold: 0.95,
      },
      "Assistant: ".repeat(60),
    );

    expect(candidates[0]).toMatchObject({
      action: "update",
      existing_memory_id: "m-near",
      update_existing_slug: "near-duplicate-rule-existing",
    });
  });
});
