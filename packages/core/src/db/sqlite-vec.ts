import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

export function enableForeignKeys(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
}

export function applyRuntimePragmas(db: Database): void {
  if (db.filename !== ":memory:") {
    db.run("PRAGMA journal_mode = WAL");
  }
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");
}

export function loadSqliteVec(db: Database): void {
  sqliteVec.load(db);
  enableForeignKeys(db);
}
