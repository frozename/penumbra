import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { applySchema, migrateT0FtsToExternalContentOnce } from "../../src/db/schema.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded by a sibling test file
}

type FtsHit = {
  event_id: string;
  content: string;
  snippet: string;
  score: number;
};

function openDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  return db;
}

function insertT0Event(
  db: Database,
  eventId: string,
  payloadJson: string,
  payloadSummary: string | null = null,
): void {
  db.run(
    `INSERT INTO t0_events(
       event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json, payload_summary
     ) VALUES (?, ?, ?, 'test', 'u', 'm', 'agent-message', 'conversation', ?, ?)`,
    [eventId, "2026-06-16T00:00:00.000Z", "2026-06-16T00:00:00.000Z", payloadJson, payloadSummary],
  );
}

function queryHits(db: Database, match: string): FtsHit[] {
  return db
    .query<FtsHit, [string]>(
      `SELECT event_id,
              content,
              snippet(t0_fts, 0, '', '', '...', 16) AS snippet,
              bm25(t0_fts) AS score
         FROM t0_fts
        WHERE t0_fts MATCH ?
        ORDER BY score, event_id
        LIMIT 10`,
    )
    .all(match);
}

function shadowContentBytes(db: Database): number {
  return (
    db
      .query<
        { bytes: number },
        []
      >(`SELECT coalesce(sum(pgsize), 0) AS bytes FROM dbstat WHERE name = 't0_fts_content'`)
      .get()?.bytes ?? 0
  );
}

function externalContentMarker(db: Database): string | undefined {
  return db
    .query<
      { value: string },
      []
    >(`SELECT value FROM db_meta WHERE key = 't0_fts_external_content_v1'`)
    .get()?.value;
}

function installLegacyStoredT0Fts(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE t0_fts USING fts5(
      content,
      event_id UNINDEXED
    );

    CREATE TRIGGER t0_fts_insert AFTER INSERT ON t0_events BEGIN
      INSERT INTO t0_fts (rowid, content, event_id) VALUES (
        new.rowid,
        CASE
          WHEN json_valid(new.payload_json) THEN coalesce(
            json_extract(new.payload_json, '$.text'),
            json_extract(new.payload_json, '$.message'),
            json_extract(new.payload_json, '$.prompt'),
            json_extract(new.payload_json, '$.message_excerpt'),
            json_extract(new.payload_json, '$.response[0].text'),
            json_extract(new.payload_json, '$.response'),
            json_extract(new.payload_json, '$.input.text'),
            json_extract(new.payload_json, '$.input.message'),
            json_extract(new.payload_json, '$.input.prompt'),
            new.payload_summary,
            ''
          )
          ELSE coalesce(new.payload_summary, new.payload_json, '')
        END,
        new.event_id
      );
    END;

    CREATE TRIGGER t0_fts_delete AFTER DELETE ON t0_events BEGIN
      DELETE FROM t0_fts WHERE rowid = old.rowid;
    END;
  `);
}

describe("t0_fts external-content migration", () => {
  test("fresh schema uses external content while preserving content, snippet, and rank queries", () => {
    const db = openDb();
    applySchema(db, { embeddingDim: 384 });

    insertT0Event(db, "text-row", JSON.stringify({ text: "alpha fresh text payload" }));
    insertT0Event(db, "message-row", JSON.stringify({ message: "alpha message payload" }));
    insertT0Event(
      db,
      "response-row",
      JSON.stringify({ response: [{ text: "alpha response payload" }] }),
    );
    insertT0Event(db, "summary-row", JSON.stringify({ ignored: true }), "alpha summary payload");

    const hits = queryHits(db, "alpha");
    expect(hits.map((hit) => hit.event_id)).toEqual([
      "message-row",
      "response-row",
      "summary-row",
      "text-row",
    ]);
    expect(hits.every((hit) => hit.content.length > 0)).toBe(true);
    expect(hits.every((hit) => hit.snippet.length > 0)).toBe(true);
    expect(hits.every((hit) => Number.isFinite(hit.score))).toBe(true);
    expect(shadowContentBytes(db)).toBe(0);
    expect(externalContentMarker(db)).toBe("1");
  });

  test("existing stored-content t0_fts is converted and delete triggers keep the index current", () => {
    const db = openDb();
    applySchema(db, { embeddingDim: 384 });
    db.exec(`
      DELETE FROM db_meta WHERE key = 't0_fts_external_content_v1';
      DROP TRIGGER IF EXISTS t0_fts_insert;
      DROP TRIGGER IF EXISTS t0_fts_delete;
      DROP VIEW IF EXISTS t0_fts_src;
      DROP TABLE IF EXISTS t0_fts;
    `);
    installLegacyStoredT0Fts(db);

    insertT0Event(db, "legacy-text", JSON.stringify({ text: "bravo legacy text" }));
    insertT0Event(db, "legacy-message", JSON.stringify({ message: "bravo legacy message" }));
    insertT0Event(
      db,
      "legacy-response",
      JSON.stringify({ response: [{ text: "bravo legacy response" }] }),
    );
    insertT0Event(db, "legacy-summary", JSON.stringify({ ignored: true }), "bravo legacy summary");

    const before = queryHits(db, "bravo").map((hit) => ({
      event_id: hit.event_id,
      content: hit.content,
      snippet: hit.snippet,
    }));
    expect(shadowContentBytes(db)).toBeGreaterThan(0);

    migrateT0FtsToExternalContentOnce(db);

    const after = queryHits(db, "bravo").map((hit) => ({
      event_id: hit.event_id,
      content: hit.content,
      snippet: hit.snippet,
    }));
    expect(after).toEqual(before);
    expect(shadowContentBytes(db)).toBe(0);

    db.run(`DELETE FROM t0_events WHERE event_id = ?`, ["legacy-message"]);
    expect(queryHits(db, "message").map((hit) => hit.event_id)).not.toContain("legacy-message");
  });

  test("migration is idempotent and leaves the marker set", () => {
    const db = openDb();
    applySchema(db, { embeddingDim: 384 });

    expect(() => migrateT0FtsToExternalContentOnce(db)).not.toThrow();
    expect(() => migrateT0FtsToExternalContentOnce(db)).not.toThrow();
    expect(externalContentMarker(db)).toBe("1");
    expect(shadowContentBytes(db)).toBe(0);
  });
});
