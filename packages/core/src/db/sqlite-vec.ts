import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';

export function enableForeignKeys(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');
}

export function loadSqliteVec(db: Database): void {
  sqliteVec.load(db);
  enableForeignKeys(db);
}
