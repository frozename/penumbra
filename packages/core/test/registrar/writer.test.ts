import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import {
  InvalidEntryTransition,
  InvalidPhaseTransition,
  RegistrarSlugTaken,
} from "@src/registrar/errors.js";
import { RegistrarReader } from "@src/registrar/reader.js";
import { RegistrarWriter, rethrowSlugUniqueConstraint } from "@src/registrar/writer.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function seedRawEntry(db: Database): void {
  db.run(
    `INSERT INTO registrar_entries
       (registrar_id, slug, title, home_project, source_doc_path, status, created_at, updated_at)
     VALUES ('registrar-1', 'registrar-one', 'Registrar one', 'penumbra', NULL, 'active', 100, 100)`,
  );
}

function insertRawEvent(
  db: Database,
  event: {
    kind: string;
    state?: string | null;
    ref_event_id?: number | null;
    link_kind?: string | null;
    link_value?: string | null;
  },
): void {
  db.run(
    `INSERT INTO registrar_events
       (registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, 'operator', 'raw event', 100)`,
    [
      "registrar-1",
      event.kind,
      event.state ?? null,
      event.ref_event_id ?? null,
      event.link_kind ?? null,
      event.link_value ?? null,
    ],
  );
}

function expectSqliteConstraint(run: () => void): void {
  try {
    run();
    throw new Error("expected SQLITE_CONSTRAINT");
  } catch (error) {
    expect((error as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT")).toBe(true);
  }
}

test("raw INSERT with kind='bogus' throws SQLITE_CONSTRAINT", () => {
  const db = makeDb();
  seedRawEntry(db);
  expectSqliteConstraint(() => {
    insertRawEvent(db, { kind: "bogus" });
  });
});

test("raw INSERT kind='blocker' state='owed' throws", () => {
  const db = makeDb();
  seedRawEntry(db);
  expectSqliteConstraint(() => {
    insertRawEvent(db, { kind: "blocker", state: "owed" });
  });
});

test("raw INSERT kind='link' with link_value NULL throws", () => {
  const db = makeDb();
  seedRawEntry(db);
  expectSqliteConstraint(() => {
    insertRawEvent(db, { kind: "link", link_kind: "commit_sha", link_value: null });
  });
});

test("raw INSERT state='resolved' with ref_event_id NULL throws", () => {
  const db = makeDb();
  seedRawEntry(db);
  expectSqliteConstraint(() => {
    insertRawEvent(db, { kind: "blocker", state: "resolved" });
  });
});

test("raw INSERT rejects a registrar event body over 4096 bytes even when it is under 4096 characters", () => {
  const db = makeDb();
  seedRawEntry(db);

  expectSqliteConstraint(() =>
    db.run(
      `INSERT INTO registrar_events
         (registrar_id, phase_no, kind, state, ref_event_id, link_kind, link_value, actor, body, created_at)
       VALUES (?, NULL, 'progress', NULL, NULL, NULL, NULL, 'maestro', ?, 100)`,
      ["registrar-1", "€".repeat(2000)],
    ),
  );
});

const createRequest = {
  title: "Registrar rollout",
  slug: "registrar-rollout",
  home_project: "penumbra",
  phases: ["Contract", "Core domain", "HTTP surface"],
};

function makeDomain(initialNow = 100): {
  db: Database;
  writer: RegistrarWriter;
  reader: RegistrarReader;
  setNow: (value: number) => void;
} {
  const db = makeDb();
  let now = initialNow;
  return {
    db,
    writer: new RegistrarWriter(db, () => now),
    reader: new RegistrarReader(db),
    setNow: (value): void => {
      now = value;
    },
  };
}

test("createEntry() with a slug that already exists throws RegistrarSlugTaken", () => {
  const { writer } = makeDomain();
  writer.createEntry(createRequest);

  expect(() => writer.createEntry({ ...createRequest, title: "Duplicate" })).toThrow(
    RegistrarSlugTaken,
  );
});

test("rethrowSlugUniqueConstraint maps the registrar slug UNIQUE violation to RegistrarSlugTaken", () => {
  const error = Object.assign(new Error("UNIQUE constraint failed: registrar_entries.slug"), {
    code: "SQLITE_CONSTRAINT_UNIQUE",
  });

  expect(() => rethrowSlugUniqueConstraint(error, "registrar-rollout")).toThrow(RegistrarSlugTaken);
});

test("rethrowSlugUniqueConstraint preserves unrelated constraint errors", () => {
  const error = Object.assign(new Error("CHECK constraint failed: status"), {
    code: "SQLITE_CONSTRAINT_CHECK",
  });

  expect(() => rethrowSlugUniqueConstraint(error, "registrar-rollout")).toThrow(error);
});

test("createEntry() defaults status='active', phase 1 'active', the rest 'pending', in one transaction", () => {
  const { writer, reader } = makeDomain();

  const entry = writer.createEntry(createRequest);

  expect(entry.status).toBe("active");
  expect(reader.listPhases(entry.registrar_id).map((phase) => phase.status)).toEqual([
    "active",
    "pending",
    "pending",
  ]);

  const rollback = makeDomain();
  rollback.db.run(`
    CREATE TRIGGER fail_second_registrar_phase
    BEFORE INSERT ON registrar_phases
    WHEN NEW.phase_no = 2
    BEGIN
      SELECT RAISE(ABORT, 'forced phase failure');
    END
  `);
  expect(() => rollback.writer.createEntry({ ...createRequest, slug: "rollback-entry" })).toThrow(
    "forced phase failure",
  );
  expect(
    rollback.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM registrar_entries")
      .get()?.count,
  ).toBe(0);
});

test("appendEvent() rejects an unknown kind at the zod boundary — listEvents() shows zero rows", () => {
  const { writer, reader } = makeDomain();
  const entry = writer.createEntry(createRequest);

  expect(() =>
    writer.appendEvent(entry.registrar_id, {
      actor: "operator",
      body: "invalid event",
      kind: "sabotage",
    }),
  ).toThrow();
  expect(reader.listEvents(entry.registrar_id)).toEqual([]);
});

test("appendEvent(kind='phase_transition', from_status='pending', state='complete') moves registrar_phases.status and bumps registrar_entries.updated_at", () => {
  const { writer, reader, setNow } = makeDomain();
  const entry = writer.createEntry(createRequest);
  setNow(200);

  writer.appendEvent(entry.registrar_id, {
    actor: "maestro",
    body: "Core domain complete",
    from_status: "pending",
    kind: "phase_transition",
    phase_no: 2,
    state: "complete",
  });

  expect(reader.listPhases(entry.registrar_id)[1]?.status).toBe("complete");
  expect(reader.getEntry(entry.registrar_id)?.updated_at).toBe(200);
});

test("two appendEvent phase transitions from the same from_status: the first succeeds, the second throws InvalidPhaseTransition and inserts no event", () => {
  const { writer, reader } = makeDomain();
  const entry = writer.createEntry(createRequest);
  const transition = {
    actor: "maestro" as const,
    body: "Core domain complete",
    from_status: "pending" as const,
    kind: "phase_transition" as const,
    phase_no: 2,
    state: "complete" as const,
  };

  writer.appendEvent(entry.registrar_id, transition);
  expect(() => writer.appendEvent(entry.registrar_id, transition)).toThrow(InvalidPhaseTransition);
  expect(reader.listEvents(entry.registrar_id)).toHaveLength(1);
});

test("appendEvent(kind='entry_transition') moves registrar_entries.status and bumps updated_at", () => {
  const { writer, reader, setNow } = makeDomain();
  const entry = writer.createEntry(createRequest);
  setNow(200);

  writer.appendEvent(entry.registrar_id, {
    actor: "maestro",
    body: "all phases landed",
    from_status: "active",
    kind: "entry_transition",
    state: "complete",
  });

  expect(reader.getEntry(entry.registrar_id)?.status).toBe("complete");
  expect(reader.getEntry(entry.registrar_id)?.updated_at).toBe(200);
});

test("appendEvent entry_transition allows draft as the source status and activates the entry", () => {
  const { db, writer, reader, setNow } = makeDomain();
  const entry = writer.createEntry(createRequest);
  db.run("UPDATE registrar_entries SET status = 'draft' WHERE registrar_id = ?", [
    entry.registrar_id,
  ]);
  setNow(200);

  writer.appendEvent(entry.registrar_id, {
    actor: "maestro",
    body: "activate draft entry",
    from_status: "draft",
    kind: "entry_transition",
    state: "active",
  });

  expect(reader.getEntry(entry.registrar_id)?.status).toBe("active");
  expect(reader.listEvents(entry.registrar_id)).toMatchObject([
    { kind: "entry_transition", state: "active" },
  ]);
});

test("appendEvent entry_transition with a wrong from_status throws InvalidEntryTransition and inserts no event", () => {
  const { writer, reader } = makeDomain();
  const entry = writer.createEntry(createRequest);

  expect(() =>
    writer.appendEvent(entry.registrar_id, {
      actor: "maestro",
      body: "should conflict",
      from_status: "paused",
      kind: "entry_transition",
      state: "abandoned",
    }),
  ).toThrow(InvalidEntryTransition);
  expect(reader.getEntry(entry.registrar_id)?.status).toBe("active");
  expect(reader.listEvents(entry.registrar_id)).toHaveLength(0);
});

test("getRollup() counts opened blockers as open until a resolved event's ref_event_id points at them", () => {
  const { writer, reader } = makeDomain();
  const entry = writer.createEntry(createRequest);
  const first = writer.appendEvent(entry.registrar_id, {
    actor: "worker",
    body: "First blocker",
    kind: "blocker",
    state: "opened",
  });
  writer.appendEvent(entry.registrar_id, {
    actor: "worker",
    body: "Second blocker",
    kind: "blocker",
    state: "opened",
  });
  writer.appendEvent(entry.registrar_id, {
    actor: "operator",
    body: "First blocker resolved",
    kind: "blocker",
    ref_event_id: first.event_id,
    state: "resolved",
  });

  expect(reader.getRollup(entry.registrar_id).open_blockers).toBe(1);
});

test("getRollup() same for follow_up owed -> done/dropped", () => {
  const { writer, reader } = makeDomain();
  const entry = writer.createEntry(createRequest);
  const done = writer.appendEvent(entry.registrar_id, {
    actor: "worker",
    body: "Document behavior",
    kind: "follow_up",
    state: "owed",
  });
  const dropped = writer.appendEvent(entry.registrar_id, {
    actor: "worker",
    body: "Remove obsolete fixture",
    kind: "follow_up",
    state: "owed",
  });
  writer.appendEvent(entry.registrar_id, {
    actor: "operator",
    body: "Documentation added",
    kind: "follow_up",
    ref_event_id: done.event_id,
    state: "done",
  });
  writer.appendEvent(entry.registrar_id, {
    actor: "operator",
    body: "Fixture retained",
    kind: "follow_up",
    ref_event_id: dropped.event_id,
    state: "dropped",
  });

  expect(reader.getRollup(entry.registrar_id).open_follow_ups).toBe(0);
});

test("listEntries() orders by updated_at desc", () => {
  const { writer, reader, setNow } = makeDomain(100);
  const first = writer.createEntry(createRequest);
  setNow(200);
  const second = writer.createEntry({ ...createRequest, slug: "second-entry", title: "Second" });
  setNow(300);
  writer.appendEvent(first.registrar_id, {
    actor: "operator",
    body: "Fresh update",
    kind: "progress",
  });

  expect(reader.listEntries().map((entry) => entry.registrar_id)).toEqual([
    first.registrar_id,
    second.registrar_id,
  ]);
});
