import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { readSubscriptionPressure } from "@src/readers/subscription-pressure.js";
import { T0EventSchema } from "@src/schemas/event.js";
import { T0Writer } from "@src/writers/t0.js";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

const sample = T0EventSchema.parse({
  event_id: "e1",
  ts: "2026-04-23T11:59:59.000Z",
  ingest_ts: "2026-04-23T12:00:00.000Z",
  source: "mcp",
  source_detail: "claude-code",
  project_id: null,
  user_id: "u",
  machine_id: "m",
  session_id: "s",
  event_type: "agent-tool-use",
  lane: "local",
  provider: null,
  model: null,
  tokens_in: null,
  tokens_out: null,
  cost_usd: null,
  latency_ms: null,
  request_id: null,
  payload_json: { tool: "Read" },
  payload_summary: "Read src/x.ts",
  origin: "maestro",
});

test("writes a row and is retrievable", () => {
  const w = new T0Writer(db);
  w.write(sample);
  const row = db
    .query<
      { event_id: string; payload_json: string; origin: string | null },
      [string]
    >("SELECT event_id, payload_json, origin FROM t0_events WHERE event_id=?")
    .get("e1");
  expect(row?.event_id).toBe("e1");
  expect(JSON.parse(row!.payload_json)).toEqual({ tool: "Read" });
  expect(row!.origin).toBe("maestro");
});

test("retirement preserves the chronologically newer timestamp across mixed ISO precision", () => {
  const writer = new T0Writer(db);
  const snapshot = {
    ...sample,
    event_type: "rate-limit-snapshot" as const,
    provider: "openai",
    ts: "2026-10-01T12:00:00Z",
    payload_json: { window_label: "secondary", model: null, used_pct: 98, resets_at: null },
  };
  writer.write(snapshot);
  const id = writer.write({
    ...snapshot,
    event_id: "retirement",
    ts: "2026-10-01T12:00:00.500Z",
    payload_json: { ...snapshot.payload_json, retired: true },
  });
  expect(
    db.query<{ ts: string }, [string]>("SELECT ts FROM t0_events WHERE event_id = ?").get(id)?.ts,
  ).toBe("2026-10-01T12:00:00.500Z");
});

test("retirement without a string window label does not bind invalid SQLite arguments", () => {
  const writer = new T0Writer(db);
  for (const window_label of [undefined, 42, { label: "secondary" }]) {
    const event = {
      ...sample,
      event_id: `invalid-window-${JSON.stringify(window_label)}`,
      event_type: "rate-limit-snapshot" as const,
      payload_json: { retired: true, window_label },
    };
    expect(writer.write(event)).toBe(event.event_id);
  }
});

test("writes origin=dispatch round-trips", () => {
  const w = new T0Writer(db);
  const dispatchEvent = T0EventSchema.parse({ ...sample, event_id: "e2", origin: "dispatch" });
  w.write(dispatchEvent);
  const row = db
    .query<{ origin: string | null }, [string]>("SELECT origin FROM t0_events WHERE event_id=?")
    .get("e2");
  expect(row!.origin).toBe("dispatch");
});

test("writes origin=null when not set (legacy compat)", () => {
  const w = new T0Writer(db);
  // Bypass schema to simulate a legacy-shaped row (origin omitted)
  const e = T0EventSchema.parse({ ...sample, event_id: "e3", origin: null });
  w.write(e);
  const row = db
    .query<{ origin: string | null }, [string]>("SELECT origin FROM t0_events WHERE event_id=?")
    .get("e3");
  expect(row!.origin).toBeNull();
});

test("duplicate event_id returns existing id without throwing, row count stays 1", () => {
  const w = new T0Writer(db);
  const firstId = w.write(sample);

  const secondId = w.write(sample);
  const rowCount = db
    .query<{ count: number }, [string]>("SELECT count(*) AS count FROM t0_events WHERE event_id=?")
    .get("e1")!.count;

  const distinctCount = db
    .query<{ count: number }, []>("SELECT count(*) AS count FROM t0_events")
    .get()!.count;

  expect(secondId).toBe(firstId);
  expect(rowCount).toBe(1);
  expect(distinctCount).toBe(1);

  const e2 = { ...sample, event_id: "e2" };
  const thirdId = w.write(e2);
  const totalCount = db
    .query<{ count: number }, []>("SELECT count(*) AS count FROM t0_events")
    .get()!.count;
  expect(totalCount).toBe(2);
  expect(thirdId).toBe("e2");
});

test("retirement deduplicates persisted groups independently of event IDs and model/provider siblings", () => {
  const writer = new T0Writer(db);
  const retirement = {
    ...sample,
    event_type: "rate-limit-snapshot" as const,
    provider: "openai",
    payload_json: {
      window_label: "secondary",
      model: null as string | null,
      retired: true,
      used_pct: 0,
      resets_at: null,
    },
  };
  const firstId = writer.write(retirement);
  expect(new T0Writer(db).write({ ...retirement, event_id: "new-report" })).toBe(firstId);
  writer.write({
    ...retirement,
    event_id: "other-model",
    payload_json: { ...retirement.payload_json, model: "codex" },
  });
  writer.write({ ...retirement, event_id: "other-provider", provider: "alibaba" });
  writer.write({
    ...retirement,
    event_id: "other-window",
    payload_json: { ...retirement.payload_json, window_label: "primary" },
  });
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t0_events").get()!.n).toBe(4);
  expect(writer.write({ ...retirement, event_id: "another-report" })).toBe(firstId);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t0_events").get()!.n).toBe(4);
});

for (const [name, activeTs, retirementTs] of [
  ["reporting clock is behind", "2026-10-01T12:00:00.000Z", "2026-10-01T11:59:59.000Z"],
  ["timestamps have different precision", "2026-10-01T12:00:00Z", "2026-10-01T12:00:00.500Z"],
] as const) {
  test(`retirement supersedes the newest stored usage when ${name}`, () => {
    const writer = new T0Writer(db);
    const snapshot = {
      ...sample,
      event_type: "rate-limit-snapshot" as const,
      provider: "openai",
      ts: activeTs,
      payload_json: {
        window_label: "secondary",
        model: null,
        used_pct: 98,
        resets_at: null,
        source_kind: "local-state-codex-rollout",
      },
    };
    writer.write(snapshot);
    const retirement = {
      ...snapshot,
      event_id: "retired-report",
      ts: retirementTs,
      payload_json: { ...snapshot.payload_json, used_pct: 0, retired: true },
    };
    const retiredId = writer.write(retirement);
    expect(readSubscriptionPressure(db)).toEqual({ snapshots: [], warnings: [] });
    expect(new T0Writer(db).write({ ...retirement, event_id: "next-report" })).toBe(retiredId);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t0_events").get()!.n).toBe(2);
  });
}

function pressureEvent(ts = "2026-10-01T12:00:00Z"): typeof sample {
  return {
    ...sample,
    event_id: "usage-poller-L1",
    ts,
    event_type: "rate-limit-snapshot" as const,
    provider: "openai",
    payload_json: {
      window_label: "secondary",
      model: null,
      used_pct: 100,
      resets_at: null,
      source_kind: "test",
    },
  };
}
test("a resurrection reporting identical metrics after retirement supersedes the tombstone", () => {
  const writer = new T0Writer(db);
  const live = pressureEvent();
  writer.write(live);
  const retired = {
    ...live,
    event_id: "retired",
    payload_json: { ...live.payload_json, retired: true },
  };
  writer.write(retired);
  const resurrectedId = writer.write({ ...live, ts: "2026-10-01T12:05:00Z" });
  expect(readSubscriptionPressure(db).snapshots.map((snapshot) => snapshot.used_pct)).toEqual([
    100,
  ]);
  expect(resurrectedId).not.toBe("usage-poller-L1");
  writer.write(retired);
  expect(readSubscriptionPressure(db).snapshots).toEqual([]);
  expect(
    db
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) AS n FROM t0_events WHERE json_extract(payload_json, '$.retired') = 1")
      .get()?.n,
  ).toBe(2);
});
test("identical live snapshots without retirement leave one row", () => {
  const writer = new T0Writer(db);
  const live = pressureEvent();
  expect(writer.write(live)).toBe(live.event_id);
  expect(writer.write(live)).toBe(live.event_id);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t0_events").get()?.n).toBe(1);
});
for (const ts of ["2026-10-01T12:00:00", "2026-10-01T12:00:00 Z"]) {
  test("retirement orders against stored ts " + ts + " by SQLite time, not V8 local time", () => {
    const previousTZ = process.env.TZ;
    try {
      process.env.TZ = "Europe/Berlin";
      const writer = new T0Writer(db);
      const live = pressureEvent(ts);
      writer.write(live);
      const id = writer.write({
        ...live,
        event_id: "retired",
        ts: "2026-10-01T11:30:00Z",
        payload_json: { ...live.payload_json, retired: true },
      });
      expect(readSubscriptionPressure(db).snapshots).toEqual([]);
      expect(
        db.query<{ ts: string }, [string]>("SELECT ts FROM t0_events WHERE event_id = ?").get(id)
          ?.ts,
      ).toBe(ts);
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    }
  });
}
test("retirement with a non-string model does not bind invalid SQLite arguments", () => {
  const writer = new T0Writer(db);
  for (const model of [{ id: "codex" }, ["codex"]]) {
    const event = {
      ...pressureEvent(),
      event_id: JSON.stringify(model),
      payload_json: { ...pressureEvent().payload_json, retired: true, model },
    };
    expect(writer.write(event)).toBe(event.event_id);
  }
});
