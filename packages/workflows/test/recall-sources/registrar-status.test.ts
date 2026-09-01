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

test("registrar_status returns an empty array and no warning on an empty DB", () => {
  const db = freshDb();
  try {
    const out = runRegistrarStatusSource({ db, args: {} });
    expect(out.rows).toEqual([]);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("registrar_status returns active entries with phases, rollup, and last event id", () => {
  const db = freshDb();
  try {
    const writer = new RegistrarWriter(db, () => 100);
    const entry = writer.createEntry({
      title: "Session handoff telemetry",
      slug: "session-handoff-telemetry",
      home_project: "penumbra",
      phases: ["Stamp", "Live state"],
    });
    writer.appendEvent(entry.registrar_id, {
      kind: "blocker",
      state: "opened",
      actor: "maestro",
      body: "open blocker",
    });
    writer.appendEvent(entry.registrar_id, {
      kind: "follow_up",
      state: "owed",
      actor: "maestro",
      body: "open follow-up",
    });

    const out = runRegistrarStatusSource({ db, args: {} });

    expect(out.rows).toEqual([
      {
        registrar_id: entry.registrar_id,
        slug: "session-handoff-telemetry",
        title: "Session handoff telemetry",
        status: "active",
        phases: [
          { phase_no: 1, title: "Stamp", status: "active" },
          { phase_no: 2, title: "Live state", status: "pending" },
        ],
        rollup: { open_blockers: 1, open_follow_ups: 1 },
        last_event_id: 2,
      },
    ]);
    expect(out.warnings).toEqual([]);
  } finally {
    db.close();
  }
});

test("registrar_status filters by registrar id/status, limits rows, and fails open", () => {
  const db = freshDb();
  try {
    const writer = new RegistrarWriter(db, () => 100);
    const active = writer.createEntry({
      title: "Active registrar",
      slug: "active-registrar",
      home_project: "penumbra",
      phases: ["One"],
    });
    const draft = writer.createEntry({
      title: "Draft registrar",
      slug: "draft-registrar",
      home_project: "penumbra",
      phases: ["One"],
    });
    db.run("UPDATE registrar_entries SET status = 'draft' WHERE registrar_id = ?", [
      draft.registrar_id,
    ]);

    expect(
      runRegistrarStatusSource({
        db,
        args: { registrar_id: draft.registrar_id, status: "draft", limit: 1 },
      }).rows.map((row) => row.slug),
    ).toEqual(["draft-registrar"]);
    expect(
      runRegistrarStatusSource({ db, args: { registrar_id: active.registrar_id } }).rows,
    ).toHaveLength(1);

    db.run("DROP TABLE registrar_events");
    const out = runRegistrarStatusSource({ db, args: {} });
    expect(out.rows).toEqual([]);
    expect(out.warnings[0]).toContain("registrar_status:");
  } finally {
    db.close();
  }
});
