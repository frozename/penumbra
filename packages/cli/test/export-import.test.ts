import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate } from "@penumbra/core";
import { runExport } from "../src/commands/export.js";
import { runImport } from "../src/commands/import.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-cli-ei-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function freshDb() {
  const path = join(dir, "db.sqlite");
  const db = new Database(path, { create: true });
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return { db, path };
}

test("export dumps JSONL, import restores it idempotently", async () => {
  const { db, path } = freshDb();
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
      session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary)
     VALUES('e1','2026-04-23T00:00:00Z','2026-04-23T00:00:00Z','mcp',null,'p','u','m','s','agent-prompt','local',
            null,null,null,null,null,null,null,'{}',null)`,
  );
  db.close();

  const outPath = join(dir, "dump.jsonl");
  await runExport({ dbPath: path, project: null, outPath });
  const dumpText = readFileSync(outPath, "utf8");
  expect(dumpText).toContain('"event_id":"e1"');

  // Wipe and re-import.
  rmSync(path);
  const { db: db2, path: path2 } = freshDb();
  db2.close();
  await runImport({ dbPath: path2, inPath: outPath });
  const db3 = new Database(path2);
  const count = db3.query<{ c: number }, []>("SELECT COUNT(*) c FROM t0_events").get()!.c;
  db3.close();
  expect(count).toBe(1);

  // Re-importing is a no-op.
  await runImport({ dbPath: path2, inPath: outPath });
  const db4 = new Database(path2);
  const count2 = db4.query<{ c: number }, []>("SELECT COUNT(*) c FROM t0_events").get()!.c;
  db4.close();
  expect(count2).toBe(1);
});
