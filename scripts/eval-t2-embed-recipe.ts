import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadSqliteVec } from "../packages/core/src/db/sqlite-vec.js";
import {
  evaluateCandidatesFromFixtures,
  type CandidateKey,
  type EmbedRecipeRow,
  writeDecision,
} from "../packages/core/test/readers/embed-recipe-bench.js";
import { BundledEmbedder } from "../packages/core/src/embedder/bundled.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

const REPO_ROOT = resolve(import.meta.dir, "..");
const FIXTURE_DIR = join(REPO_ROOT, "packages/core/test/readers/fixtures/t2-embed-recipe");
const DEFAULT_DB_PATH = join(process.env.HOME ?? "", ".penumbra/db.sqlite");

interface T2MemoryRow extends EmbedRecipeRow {
  rowid: number;
  retired_at: string | null;
}

function stableRows(rows: EmbedRecipeRow[]): EmbedRecipeRow[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

async function captureFixtures(db: Database): Promise<{
  weakRows: EmbedRecipeRow[];
  goldenRows: EmbedRecipeRow[];
  corpusRows: EmbedRecipeRow[];
  queries: string[];
}> {
  const embedder = new BundledEmbedder();
  const queryRows = db
    .query<{ query_text: string }, []>(
      `SELECT DISTINCT TRIM(query_text) AS query_text
         FROM recall_audit
        WHERE query_text IS NOT NULL
          AND TRIM(query_text) <> ''
          AND json_valid(result_ids)
          AND json_array_length(result_ids) > 3
        ORDER BY query_text COLLATE NOCASE ASC`,
    )
    .all();
  const queries = queryRows.map((r) => r.query_text);

  const activeWithVec = db
    .query<T2MemoryRow, []>(
      `SELECT m.rowid, m.memory_id AS id, m.title, m.body, m.retired_at
         FROM t2_memories m
         JOIN t2_vec v ON v.rowid = m.rowid
        WHERE m.retired_at IS NULL`,
    )
    .all();

  const allT2 = db
    .query<T2MemoryRow, []>(
      `SELECT m.rowid, m.memory_id AS id, m.title, m.body, m.retired_at
         FROM t2_memories m`,
    )
    .all();

  const recalled = db
    .query<{ id: string }, []>(
      `SELECT DISTINCT m.memory_id AS id
         FROM recall_audit ra, json_each(ra.result_ids) je
         JOIN t2_memories m ON m.memory_id = CAST(je.value AS TEXT)
        WHERE json_valid(ra.result_ids)
          AND ra.query_text IS NOT NULL
          AND TRIM(ra.query_text) <> ''
          AND json_array_length(ra.result_ids) > 3`,
    )
    .all();
  const recalledIds = new Set(recalled.map((r) => r.id));

  const poolIds = new Set<string>();
  for (const queryText of queries) {
    const [qvec] = await embedder.embed([queryText]);
    const top = db
      .query<{ id: string }, [Float32Array]>(
        `SELECT m.memory_id AS id
           FROM t2_vec v
           JOIN t2_memories m ON m.rowid = v.rowid
          WHERE v.embedding MATCH ?
            AND k = 20
            AND m.retired_at IS NULL
          ORDER BY v.distance ASC`,
      )
      .all(qvec!);
    for (const hit of top) poolIds.add(hit.id);
  }

  const weakRows = activeWithVec.filter((row) => !recalledIds.has(row.id) && !poolIds.has(row.id));
  const goldenRows = allT2.filter((row) => recalledIds.has(row.id));

  return {
    weakRows: stableRows(weakRows.map(({ id, title, body }) => ({ id, title, body }))),
    goldenRows: stableRows(goldenRows.map(({ id, title, body }) => ({ id, title, body }))),
    corpusRows: stableRows(activeWithVec.map(({ id, title, body }) => ({ id, title, body }))),
    queries,
  };
}

function chooseDecision(scorecard: Awaited<ReturnType<typeof evaluateCandidatesFromFixtures>>): {
  key: CandidateKey;
  note?: string;
} {
  const runnable = scorecard.filter((row) => row.runnable);
  if (runnable.length === 0) {
    throw new Error("No runnable candidates. Ensure at least AllMiniLML6V2 is available.");
  }

  const passing = runnable.filter((row) => (row.weakLift ?? -Infinity) >= 40 && (row.regressionCount ?? Infinity) <= 5);
  const sortBest = (a: (typeof runnable)[number], b: (typeof runnable)[number]) =>
    (b.weakLift ?? -Infinity) - (a.weakLift ?? -Infinity) ||
    (a.regressionCount ?? Infinity) - (b.regressionCount ?? Infinity) ||
    a.key.localeCompare(b.key);

  if (passing.length > 0) {
    passing.sort(sortBest);
    return { key: passing[0]!.key };
  }

  runnable.sort(sortBest);
  return {
    key: runnable[0]!.key,
    note: "No candidate met weakLift>=40 and regressionCount<=5 in this run; selected best available runnable candidate.",
  };
}

async function main(): Promise<void> {
  const dbPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_DB_PATH;
  await mkdir(FIXTURE_DIR, { recursive: true });

  const db = new Database(dbPath, { readonly: true });
  loadSqliteVec(db);
  try {
    const fixtures = await captureFixtures(db);
    await Bun.write(join(FIXTURE_DIR, "weak-rows.json"), `${JSON.stringify(fixtures.weakRows, null, 2)}\n`);
    await Bun.write(join(FIXTURE_DIR, "golden-rows.json"), `${JSON.stringify(fixtures.goldenRows, null, 2)}\n`);
    await Bun.write(join(FIXTURE_DIR, "corpus-rows.json"), `${JSON.stringify(fixtures.corpusRows, null, 2)}\n`);
    await Bun.write(join(FIXTURE_DIR, "queries.json"), `${JSON.stringify(fixtures.queries, null, 2)}\n`);

    const scorecard = await evaluateCandidatesFromFixtures(fixtures);
    const decision = chooseDecision(scorecard);
    await writeDecision({
      candidateKey: decision.key,
      selectedAt: new Date().toISOString(),
      note: decision.note,
    });

    console.log(
      JSON.stringify(
        {
          dbPath,
          fixtureDir: FIXTURE_DIR,
          weakRows: fixtures.weakRows.length,
          goldenRows: fixtures.goldenRows.length,
          corpusRows: fixtures.corpusRows.length,
          queries: fixtures.queries.length,
          scorecard,
          decision,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

await main();
