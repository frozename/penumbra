import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { readJudgeDecisions } from "@src/readers/judge-decisions.js";
import { writeJudgeDecision, type WriteJudgeDecisionInput } from "@src/writers/judge-decisions.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

function makeInput(overrides: Partial<WriteJudgeDecisionInput> = {}): WriteJudgeDecisionInput {
  return {
    decisionId: "jd-1",
    site: "dream.p1.promotion",
    subjectId: "t1-rollup-9",
    mode: "shadow",
    model: "jev-1.13.0",
    incumbent: {
      votes: [
        { promote: true, confidence: 0.8 },
        { promote: false, confidence: 0.6 },
      ],
    },
    jev: { answers: { promote: { type: "noul", noul: 0.91 } } },
    usageInputTokens: 312,
    createdAt: "2026-09-18T12:00:00.000Z",
    ...overrides,
  };
}

describe("judge_decisions shadow sink", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  afterEach(() => {
    db.close();
  });

  test("the migrated schema exposes the judge_decisions columns", () => {
    const columns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('judge_decisions')")
      .all()
      .map((column) => column.name)
      .sort();

    expect(columns).toEqual([
      "applied",
      "created_at",
      "decision_id",
      "incumbent_json",
      "jev_json",
      "mode",
      "model",
      "site",
      "subject_id",
      "usage_input_tokens",
    ]);
  });

  test("write then read round-trips every field with applied = 0", () => {
    const input = makeInput();

    writeJudgeDecision(db, input);

    const [record] = readJudgeDecisions(db, { site: "dream.p1.promotion" });
    expect(record).toEqual({
      decisionId: "jd-1",
      site: "dream.p1.promotion",
      subjectId: "t1-rollup-9",
      mode: "shadow",
      model: "jev-1.13.0",
      incumbent: input.incumbent,
      jev: input.jev,
      applied: false,
      usageInputTokens: 312,
      createdAt: "2026-09-18T12:00:00.000Z",
    });
  });

  test("raw inserts violating the shadow or token CHECK constraints fail", () => {
    expect(() =>
      db.run(
        `INSERT INTO judge_decisions (
           decision_id, site, subject_id, mode, model, incumbent_json, jev_json,
           applied, usage_input_tokens, created_at
         ) VALUES (
           'raw-shadow-applied', 'dream.p1.promotion', 'sub', 'shadow', 'm',
           '{}', '{}', 1, 0, '2026-09-18T00:00:00.000Z'
         )`,
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.run(
        `INSERT INTO judge_decisions (
           decision_id, site, subject_id, mode, model, incumbent_json, jev_json,
           applied, usage_input_tokens, created_at
         ) VALUES (
           'raw-negative-tokens', 'dream.p1.promotion', 'sub', 'shadow', 'm',
           '{}', '{}', 0, -1, '2026-09-18T00:00:00.000Z'
         )`,
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  test("the writer rejects non-integer tokens and non-serialisable payloads", () => {
    const rowCount = (): number | undefined =>
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM judge_decisions").get()?.n;

    expect(() => {
      writeJudgeDecision(db, makeInput({ usageInputTokens: 1.5 }));
    }).toThrow(RangeError);
    expect(rowCount()).toBe(0);
    expect(() => {
      writeJudgeDecision(db, makeInput({ usageInputTokens: -1 }));
    }).toThrow(RangeError);
    expect(rowCount()).toBe(0);
    expect(() => {
      writeJudgeDecision(db, makeInput({ jev: undefined }));
    }).toThrow(TypeError);
    expect(rowCount()).toBe(0);
    expect(() => {
      writeJudgeDecision(db, makeInput({ incumbent: undefined }));
    }).toThrow(TypeError);
    expect(rowCount()).toBe(0);
  });

  test("read filters by site, subject, and sinceIso, orders newest first, then limits", () => {
    writeJudgeDecision(
      db,
      makeInput({
        decisionId: "jd-1",
        site: "dream.p1.promotion",
        subjectId: "sub-1",
        createdAt: "2026-09-18T12:00:00.000Z",
      }),
    );
    writeJudgeDecision(
      db,
      makeInput({
        decisionId: "jd-2",
        site: "dream.p1.promotion",
        subjectId: "sub-2",
        createdAt: "2026-09-18T12:30:00.000Z",
      }),
    );
    writeJudgeDecision(
      db,
      makeInput({
        decisionId: "jd-3",
        site: "memory.efficacy",
        subjectId: "sub-1",
        createdAt: "2026-09-18T13:00:00.000Z",
      }),
    );

    const bySite = readJudgeDecisions(db, { site: "dream.p1.promotion" });
    const bySubject = readJudgeDecisions(db, { subjectId: "sub-1" });
    const bySince = readJudgeDecisions(db, { sinceIso: "2026-09-18T12:30:00.000Z" });
    const limited = readJudgeDecisions(db, { limit: 2 });

    expect(bySite.map((record) => record.decisionId)).toEqual(["jd-2", "jd-1"]);
    expect(bySubject.map((record) => record.decisionId)).toEqual(["jd-3", "jd-1"]);
    expect(bySince.map((record) => record.decisionId)).toEqual(["jd-3", "jd-2"]);
    expect(limited.map((record) => record.decisionId)).toEqual(["jd-3", "jd-2"]);
  });

  test("re-migrating a v45 database recreates the table and stamps the new version", () => {
    db.run("DROP TABLE judge_decisions");
    db.run("UPDATE db_meta SET value = '45' WHERE key = 'schema_version'");

    migrate(db, { embeddingDim: 384 });

    const table = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'judge_decisions'")
      .get();
    const marker = db
      .query<{ value: string }, []>("SELECT value FROM db_meta WHERE key = 'schema_version'")
      .get();

    expect(table?.name).toBe("judge_decisions");
    expect(marker?.value).toBe(String(SCHEMA_VERSION));
  });
});
