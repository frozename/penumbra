import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { ChainReader } from "@src/readers/chain.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
let reader: ChainReader;

function isoAt(offsetMinutes: number): string {
  const base = Date.parse("2026-05-05T00:00:00.000Z");
  return new Date(base + offsetMinutes * 60_000).toISOString();
}

function insertEvent(opts: {
  event_id: string;
  ts: string;
  session_id: string;
  event_type: string;
  ingest_ts?: string;
  payload_json?: string;
}): void {
  db.run(
    `INSERT INTO t0_events (
       event_id, ts, ingest_ts, source, source_detail, project_id, user_id,
       machine_id, session_id, event_type, lane, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.event_id,
      opts.ts,
      opts.ingest_ts ?? opts.ts,
      "agentchat",
      null,
      null,
      "u1",
      "m1",
      opts.session_id,
      opts.event_type,
      "local",
      opts.payload_json ?? "{}",
    ],
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  reader = new ChainReader(db);
});

afterEach(() => {
  db.close();
});

test("getMessages default legacy path keeps oldest ordering and caps at 1000", () => {
  for (let i = 0; i < 1201; i++) {
    insertEvent({
      event_id: `legacy-${String(i)}`,
      ts: isoAt(i),
      session_id: "c-big",
      event_type: "agent-thought",
    });
  }

  const events = reader.getMessages("c-big");
  expect(events.length).toBe(1000);
  expect(events[0]?.event_id).toBe("legacy-0");
  expect(events.at(-1)?.event_id).toBe("legacy-999");
});

test("legacy explicit limit keeps oldest ordering for limit 500", () => {
  for (let i = 0; i < 1201; i++) {
    insertEvent({
      event_id: `legacy-${String(i)}`,
      ts: isoAt(i),
      session_id: "c-big",
      event_type: "agent-thought",
    });
  }

  const events = reader.getMessages("c-big", undefined, { limit: 500 });
  expect(events.length).toBe(500);
  expect(events[0]?.event_id).toBe("legacy-0");
  expect(events.at(-1)?.event_id).toBe("legacy-499");
});

test("tail mode defaults to newest 500 with tail sorting and deterministic tie-breakers", () => {
  for (let i = 0; i < 10; i++) {
    insertEvent({
      event_id: `legacy-${String(i)}`,
      ts: isoAt(i),
      session_id: "c-tail-default",
      event_type: "agent-thought",
    });
  }

  insertEvent({
    event_id: "tie-001",
    ts: isoAt(10),
    session_id: "c-tail-default",
    event_type: "agent-thought",
    ingest_ts: "2026-05-05T00:10:00.000Z",
  });
  insertEvent({
    event_id: "tie-200",
    ts: isoAt(10),
    session_id: "c-tail-default",
    event_type: "agent-thought",
    ingest_ts: "2026-05-05T00:10:00.000Z",
  });
  insertEvent({
    event_id: "tie-150",
    ts: isoAt(10),
    session_id: "c-tail-default",
    event_type: "agent-thought",
    ingest_ts: "2026-05-05T00:10:00.000Z",
  });

  const events = reader.getMessages("c-tail-default", undefined, { tail: true });
  expect(events.length).toBe(13);
  expect(events.map((event) => event.event_id)).toEqual([
    "legacy-0",
    "legacy-1",
    "legacy-2",
    "legacy-3",
    "legacy-4",
    "legacy-5",
    "legacy-6",
    "legacy-7",
    "legacy-8",
    "legacy-9",
    "tie-001",
    "tie-150",
    "tie-200",
  ]);
});

test("tail mode with omitted limit returns the newest 500 rows", () => {
  for (let i = 0; i < 1201; i++) {
    insertEvent({
      event_id: `crop-${String(i)}`,
      ts: isoAt(i),
      session_id: "c-tail-crop",
      event_type: "agent-thought",
    });
  }

  insertEvent({
    event_id: "foreign",
    ts: isoAt(2000),
    session_id: "other-conversation",
    event_type: "agent-response",
  });
  const events = reader.getMessages("c-tail-crop", undefined, { tail: true });
  expect(events.length).toBe(500);
  expect(events.at(0)?.event_id).toBe("crop-701");
  expect(events.at(-1)?.event_id).toBe("crop-1200");
  const expectedIds = Array.from({ length: 500 }, (_, index) => `crop-${String(index + 701)}`);
  expect(events.map((event) => event.event_id)).toEqual(expectedIds);
  expect(
    reader
      .getMessages("c-tail-crop", undefined, { tail: true, limit: 500 })
      .map((event) => event.event_id),
  ).toEqual(expectedIds);
});

test("tail mode respects explicit limit and includes strict before_ts filtering before membership", () => {
  for (let i = 0; i < 12; i++) {
    insertEvent({
      event_id: `tail-${String(i)}`,
      ts: isoAt(i),
      session_id: "c-tail-filter",
      event_type: i % 2 === 0 ? "agent-response" : "agent-thought",
    });
  }

  const events = reader.getMessages("c-tail-filter", ["agent-response"], {
    tail: true,
    limit: 2,
    before_ts: isoAt(11),
  });
  expect(events.map((event) => event.event_id)).toEqual(["tail-8", "tail-10"]);
});

test("tail mode validates all original options before database work", () => {
  const querySpy = spyOn(db, "query");
  const invalidOptions = [
    { tail: "true" },
    { tail: null },
    { tail: 1 },
    { tail: "false" },
    { tail: true, extra: true },
    { tail: true, offset: 1 },
    { tail: true, offset: null },
    { tail: true, before_ts: 123 },
    ...[0, -1, 1.5, 501, Number.NaN, Number.POSITIVE_INFINITY, "2"].map((limit) => ({
      tail: true,
      limit,
    })),
  ];
  try {
    for (const opts of invalidOptions) {
      let error: unknown;
      try {
        reader.getMessages(
          "c",
          undefined,
          opts as unknown as Parameters<ChainReader["getMessages"]>[2],
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("ZodError");
    }
    expect(querySpy).not.toHaveBeenCalled();
  } finally {
    querySpy.mockRestore();
  }
});

test("tail tie cutoff orders ingestion before ids and excludes newer foreign rows", () => {
  for (const [event_id, ingest_ts] of [
    ["z", isoAt(1)],
    ["a", isoAt(2)],
    ["c", isoAt(2)],
    ["b", isoAt(2)],
  ] as const) {
    insertEvent({
      event_id,
      ingest_ts,
      ts: isoAt(0),
      session_id: "ties",
      event_type: "agent-response",
    });
  }
  insertEvent({
    event_id: "newer-foreign",
    ts: isoAt(3),
    session_id: "other",
    event_type: "agent-response",
  });
  expect(
    reader.getMessages("ties", undefined, { tail: true, limit: 2 }).map((event) => event.event_id),
  ).toEqual(["b", "c"]);
  expect(
    reader.getMessages("ties", undefined, { tail: true }).map((event) => event.event_id),
  ).toEqual(["z", "a", "b", "c"]);
});

test("tail keeps short and empty results and malformed payload null", () => {
  expect(reader.getMessages("empty", undefined, { tail: true })).toEqual([]);
  insertEvent({
    event_id: "malformed",
    ts: isoAt(0),
    session_id: "short",
    event_type: "agent-response",
    payload_json: "not JSON",
  });
  expect(reader.getMessages("short", undefined, { tail: true })).toEqual([
    {
      event_id: "malformed",
      ts: isoAt(0),
      event_type: "agent-response",
      source: "agentchat",
      source_detail: null,
      user_id: "u1",
      payload: null,
    },
  ]);
});

test("tail rejects unknown original options instead of stripping them", () => {
  const querySpy = spyOn(db, "query");
  try {
    expect(() =>
      reader.getMessages("c", undefined, { tail: true, extra: true } as never),
    ).toThrow();
    expect(querySpy).not.toHaveBeenCalled();
  } finally {
    querySpy.mockRestore();
  }
});
