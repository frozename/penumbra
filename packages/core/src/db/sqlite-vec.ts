import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';

export function loadSqliteVec(db: Database): void {
  sqliteVec.load(db);
}
