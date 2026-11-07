import { applySchema, loadSqliteVec, RegistrarWriter } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runRegistrarStatusSource } from "@src/recall-sources/registrar-status.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

function createActiveEntries(db: Database, count: number): void {
  const writer = new RegistrarWriter(db, () => 100);
  for (let i = 0; i < count; i++) {
    const tag = String(i);
    writer.createEntry({
      title: `Registrar ${tag}`,
      slug: `reg-${tag}`,
      home_project: "penumbra",
      phases: ["One"],
    });
  }
}

test("registrar_status defaults limit to 5 when no limit arg is given", () => {
  const db = freshDb();
  try {
    createActiveEntries(db, 6);
    const out = runRegistrarStatusSource({ db, args: {} });
    expect(out.rows).toHaveLength(5);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("registrar_status caps limit at 50", () => {
  const db = freshDb();
  try {
    createActiveEntries(db, 51);
    const out = runRegistrarStatusSource({ db, args: { limit: 100 } });
    expect(out.rows).toHaveLength(50);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("registrar_status raises limit 0 to 1", () => {
  const db = freshDb();
  try {
    createActiveEntries(db, 3);
    const out = runRegistrarStatusSource({ db, args: { limit: 0 } });
    expect(out.rows).toHaveLength(1);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("registrar_status falls back to limit 5 for a non-finite limit", () => {
  const db = freshDb();
  try {
    createActiveEntries(db, 6);
    const out = runRegistrarStatusSource({ db, args: { limit: Number.POSITIVE_INFINITY } });
    expect(out.rows).toHaveLength(5);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("registrar_status falls back to active for an unknown status", () => {
  const db = freshDb();
  try {
    const writer = new RegistrarWriter(db, () => 100);
    const active = writer.createEntry({
      title: "Active registrar",
      slug: "reg-active",
      home_project: "penumbra",
      phases: ["One"],
    });
    const draft = writer.createEntry({
      title: "Draft registrar",
      slug: "reg-draft",
      home_project: "penumbra",
      phases: ["One"],
    });
    db.run("UPDATE registrar_entries SET status = 'draft' WHERE registrar_id = ?", [
      draft.registrar_id,
    ]);

    const out = runRegistrarStatusSource({ db, args: { status: "bogus" } });
    expect(out.rows.map((row) => row.slug)).toEqual([active.slug]);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("registrar_status returns no rows when registrar_id status differs from requested status", () => {
  const db = freshDb();
  try {
    const writer = new RegistrarWriter(db, () => 100);
    const draft = writer.createEntry({
      title: "Draft registrar",
      slug: "reg-diff-status",
      home_project: "penumbra",
      phases: ["One"],
    });
    db.run("UPDATE registrar_entries SET status = 'draft' WHERE registrar_id = ?", [
      draft.registrar_id,
    ]);

    const out = runRegistrarStatusSource({ db, args: { registrar_id: draft.registrar_id } });
    expect(out.rows).toEqual([]);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("registrar_status returns no rows for an unknown registrar_id", () => {
  const db = freshDb();
  try {
    createActiveEntries(db, 1);
    const out = runRegistrarStatusSource({ db, args: { registrar_id: "does-not-exist" } });
    expect(out.rows).toEqual([]);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("registrar_status reports last_event_id null for an entry with no events", () => {
  const db = freshDb();
  try {
    createActiveEntries(db, 1);
    const out = runRegistrarStatusSource({ db, args: {} });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.last_event_id).toBeNull();
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});
