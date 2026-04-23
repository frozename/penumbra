import { Database } from 'bun:sqlite';

export class DbMeta {
  constructor(private db: Database) {}

  get(key: string): string | undefined {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM db_meta WHERE key=?')
      .get(key);
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db.run(
      'INSERT INTO db_meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, value],
    );
  }

  getNumber(key: string): number | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
}
