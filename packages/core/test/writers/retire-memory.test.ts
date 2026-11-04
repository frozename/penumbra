import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { retireMemory, retireNonDirectMemory } from "@src/writers/retire-memory.js";

const NOW = 1_700_000_000_000;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE t2_memories (memory_id TEXT PRIMARY KEY, retired_at INTEGER, origin TEXT)`);
  return db;
}

function makeLegacyDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE t2_memories (memory_id TEXT PRIMARY KEY, retired_at INTEGER)`);
  return db;
}

function insert(
  db: Database,
  id: string,
  origin: string | null,
  retiredAt: number | null = null,
): void {
  db.prepare(`INSERT INTO t2_memories (memory_id, retired_at, origin) VALUES (?, ?, ?)`).run(
    id,
    retiredAt,
    origin,
  );
}

function insertLegacy(db: Database, id: string, retiredAt: number | null = null): void {
  db.prepare(`INSERT INTO t2_memories (memory_id, retired_at) VALUES (?, ?)`).run(id, retiredAt);
}

function retiredAt(db: Database, id: string): number | null {
  const row = db
    .query<
      { retired_at: number | null },
      [string]
    >(`SELECT retired_at FROM t2_memories WHERE memory_id = ?`)
    .get(id);
  if (!row) throw new Error("missing row " + id);
  return row.retired_at;
}

describe("retireNonDirectMemory", () => {
  it("retires a live memory with origin 'curator'", () => {
    const db = makeDb();
    insert(db, "m1", "curator");
    expect(retireNonDirectMemory(db, "m1", NOW)).toBe(true);
    expect(retiredAt(db, "m1")).toBe(NOW);
    db.close();
  });

  it("retires a live memory with an explicit NULL origin", () => {
    const db = makeDb();
    insert(db, "m1", null);
    expect(retireNonDirectMemory(db, "m1", NOW)).toBe(true);
    expect(retiredAt(db, "m1")).toBe(NOW);
    db.close();
  });

  it("does not retire origin='direct' memories", () => {
    const db = makeDb();
    insert(db, "m1", "direct");
    expect(retireNonDirectMemory(db, "m1", NOW)).toBe(false);
    expect(retiredAt(db, "m1")).toBe(null);
    db.close();
  });

  it("does not overwrite an already retired memory", () => {
    const db = makeDb();
    insert(db, "m1", "curator", 123);
    expect(retireNonDirectMemory(db, "m1", NOW)).toBe(false);
    expect(retiredAt(db, "m1")).toBe(123);
    db.close();
  });

  it("changes nothing for an unknown memory_id", () => {
    const db = makeDb();
    insert(db, "m1", "curator");
    expect(retireNonDirectMemory(db, "nope", NOW)).toBe(false);
    expect(retiredAt(db, "m1")).toBe(null);
    db.close();
  });

  it("only changes the target row", () => {
    const db = makeDb();
    insert(db, "m1", "curator");
    insert(db, "m2", "curator");
    expect(retireNonDirectMemory(db, "m1", NOW)).toBe(true);
    expect(retiredAt(db, "m1")).toBe(NOW);
    expect(retiredAt(db, "m2")).toBe(null);
    db.close();
  });

  it("still retires a live memory on a legacy table without an origin column", () => {
    const db = makeLegacyDb();
    insertLegacy(db, "m1");
    let r: boolean | undefined;
    expect(() => {
      r = retireNonDirectMemory(db, "m1", NOW);
    }).not.toThrow();
    expect(r).toBe(true);
    expect(retiredAt(db, "m1")).toBe(NOW);
    db.close();
  });

  it("does not overwrite an already retired memory on a legacy table", () => {
    const db = makeLegacyDb();
    insertLegacy(db, "m1", 123);
    expect(retireNonDirectMemory(db, "m1", NOW)).toBe(false);
    expect(retiredAt(db, "m1")).toBe(123);
    db.close();
  });

  it("exposes retireMemory as the same function as retireNonDirectMemory", () => {
    expect(retireMemory).toBe(retireNonDirectMemory);
  });
});
