import { ChainReader, type Services } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { chainsMessagesRoute } from "@src/routes/chains-messages.js";
import { chainsMessagesRoute as originalRoute } from "@src/routes/chains.js";

type Message = ReturnType<ChainReader["getMessages"]>[number];
type Seed = {
  event_id: string;
  ts: string;
  ingest_ts?: string;
  session_id?: string;
  event_type?: string;
  payload_json?: string;
};

const conversationId = "chain/with % and space";
const validationError = {
  error: { code: "validation_error", message: "Invalid transcript tail options" },
};
let db: Database;
let reader: ChainReader;
let services: Services;

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE t0_events (
    event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, ingest_ts TEXT NOT NULL,
    session_id TEXT NOT NULL, event_type TEXT NOT NULL, source TEXT NOT NULL,
    source_detail TEXT, user_id TEXT, payload_json TEXT NOT NULL
  )`);
  reader = new ChainReader(db);
  services = { chainReader: reader } as Services;
});

afterEach(() => {
  db.close();
});

function seed(rows: Seed[]): void {
  const insert = db.prepare("INSERT INTO t0_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const row of rows) {
      insert.run(
        row.event_id,
        row.ts,
        row.ingest_ts ?? row.ts,
        row.session_id ?? conversationId,
        row.event_type ?? "user-prompt",
        "agentchat",
        "test-source",
        "user-1",
        row.payload_json ?? JSON.stringify({ event_id: row.event_id }),
      );
    }
  })();
}

function numberedRows(count: number): Seed[] {
  return Array.from({ length: count }, (_, index) => ({
    event_id: `event-${String(index).padStart(4, "0")}`,
    ts: `opaque-${String(index).padStart(4, "0")}`,
    event_type: index % 2 ? "agent-response" : "user-prompt",
  }));
}

function request(params: Record<string, string> = {}): Request {
  const query = new URLSearchParams({ conversation_id: conversationId, ...params });
  return new Request(`http://localhost/chains/messages?${query.toString()}`);
}

async function events(params: Record<string, string> = {}): Promise<Message[]> {
  const response = chainsMessagesRoute(request(params), services);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { events: Message[] };
  expect(Object.keys(body)).toEqual(["events"]);
  return body.events;
}

function ids(rows: { event_id: string }[]): string[] {
  return rows.map((row) => row.event_id);
}

test("GET /chains/messages re-export is the same handler from chains.ts", async () => {
  expect(originalRoute).toBe(chainsMessagesRoute);
  seed([{ event_id: "marker", ts: "opaque" }]);
  const response = originalRoute(request({ tail: "true", limit: "1" }), services);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    events: [
      {
        event_id: "marker",
        ts: "opaque",
        event_type: "user-prompt",
        source: "agentchat",
        source_detail: "test-source",
        user_id: "user-1",
        payload: { event_id: "marker" },
      },
    ],
  });
});

test("GET /chains/messages tail=true defaults to newest 500 and returns newest rows in chronological order", async () => {
  const rows = numberedRows(1201);
  seed(rows);
  seed([{ event_id: "foreign-newer", ts: "z-newest", session_id: "other-chain" }]);
  expect(ids(await events())).toEqual(ids(rows.slice(0, 1000)));
  expect(ids(await events({ limit: "500" }))).toEqual(ids(rows.slice(0, 500)));
  expect(ids(await events({ tail: "false" }))).toEqual(ids(rows.slice(0, 1000)));
  expect(ids(await events({ tail: "true" }))).toEqual(ids(rows.slice(-500)));
  expect(ids(await events({ tail: "true", limit: "500" }))).toEqual(ids(rows.slice(-500)));
});

test("GET /chains/messages tail=true with explicit limit and offset=0 applies strict tail membership", async () => {
  seed([
    { event_id: "older", ts: "a" },
    { event_id: "z-ingest-first", ts: "same", ingest_ts: "i-1" },
    { event_id: "a-cutoff", ts: "same", ingest_ts: "i-2" },
    { event_id: "b-selected", ts: "same", ingest_ts: "i-2" },
    { event_id: "c-selected", ts: "same", ingest_ts: "i-2" },
    { event_id: "a-ingest-last", ts: "same", ingest_ts: "i-3" },
    { event_id: "foreign-newer", ts: "z", session_id: "foreign" },
  ]);
  expect(ids(await events({ tail: "true", limit: "3", offset: "0" }))).toEqual([
    "b-selected",
    "c-selected",
    "a-ingest-last",
  ]);
});

test("GET /chains/messages tail=true filters types and strict opaque before_ts before selecting bounded rows", async () => {
  seed(numberedRows(12));
  expect(
    ids(
      await events({
        tail: "true",
        limit: "2",
        types: " , agent-response, ,",
        before_ts: "opaque-0009",
      }),
    ),
  ).toEqual(["event-0005", "event-0007"]);
  expect(ids(await events({ tail: "true", limit: "2", types: " , ", before_ts: "" }))).toEqual([
    "event-0010",
    "event-0011",
  ]);
  expect(ids(await events({ tail: "true", limit: "2", types: "unknown" }))).toEqual([]);
});

test("GET /chains/messages handles empty and short transcripts and preserves malformed payload as null", async () => {
  expect(await events({ tail: "true" })).toEqual([]);
  seed([
    { event_id: "good", ts: "a" },
    { event_id: "malformed", ts: "b", payload_json: "{invalid" },
  ]);
  const rows = await events({ tail: "true" });
  expect(ids(rows)).toEqual(["good", "malformed"]);
  expect(rows[1]).toEqual({
    event_id: "malformed",
    ts: "b",
    event_type: "user-prompt",
    source: "agentchat",
    source_detail: "test-source",
    user_id: "user-1",
    payload: null,
  });
  expect((await events())[1]?.payload).toBeNull();
});

const invalidLimits = [
  "",
  "0",
  "-1",
  "01",
  "+1",
  " 1",
  "1 ",
  "1.5",
  "1e2",
  "0x10",
  "2junk",
  "NaN",
  "Infinity",
  "501",
  "9".repeat(400),
];
const invalidOffsets = [
  "",
  "00",
  "1",
  "-1",
  "-0",
  "+0",
  " 0",
  "0 ",
  "0.0",
  "0e0",
  "0x0",
  "0junk",
  "NaN",
  "Infinity",
];
const invalidFlags = [
  "",
  "TRUE",
  "False",
  "1",
  "0",
  " true",
  "true ",
  "null",
  "undefined",
  "maybe",
];
const invalidOptions: [string, string][] = [
  ...invalidLimits.map((value) => ["limit", value] as [string, string]),
  ...invalidOffsets.map((value) => ["offset", value] as [string, string]),
  ...invalidFlags.map((value) => ["tail", value] as [string, string]),
];

test.each(invalidOptions)(
  "GET /chains/messages rejects invalid raw %s=%j before reader or SQLite query",
  async (key, value) => {
    const readerSpy = spyOn(reader, "getMessages");
    const querySpy = spyOn(db, "query");
    try {
      const response = chainsMessagesRoute(request({ tail: "true", [key]: value }), services);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(validationError);
      expect(readerSpy).not.toHaveBeenCalled();
      expect(querySpy).not.toHaveBeenCalled();
    } finally {
      readerSpy.mockRestore();
      querySpy.mockRestore();
    }
  },
);

test.each(["", "conversation_id=&"])(
  "GET /chains/messages missing or empty conversation takes priority: %j",
  async (prefix) => {
    const readerSpy = spyOn(reader, "getMessages");
    const querySpy = spyOn(db, "query");
    try {
      for (const options of ["tail=invalid&limit=501", "tail=true&limit=0", "tail=false", ""]) {
        const response = chainsMessagesRoute(
          new Request(`http://localhost/chains/messages?${prefix}${options}`),
          services,
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: { code: "missing_param", message: "conversation_id query parameter is required" },
        });
      }
      expect(readerSpy).not.toHaveBeenCalled();
      expect(querySpy).not.toHaveBeenCalled();
    } finally {
      readerSpy.mockRestore();
      querySpy.mockRestore();
    }
  },
);

test.each([undefined, "false"])(
  "GET /chains/messages legacy tail=%s preserves numeric parsing, offsets, types and opaque timestamps",
  async (tail) => {
    const rows = numberedRows(1201);
    seed(rows);
    const mode: Record<string, string> = {};
    if (tail !== undefined) mode.tail = tail;
    for (const limit of ["2junk", "2.9"]) {
      expect(ids(await events({ ...mode, limit }))).toEqual(ids(rows.slice(0, 2)));
    }
    for (const limit of ["", "0", "-1", "NaN", "Infinity", "junk"]) {
      expect(ids(await events({ ...mode, limit }))).toEqual(ids(rows.slice(0, 1000)));
    }
    for (const offset of ["2junk", "2.9"]) {
      expect(ids(await events({ ...mode, limit: "2", offset }))).toEqual(ids(rows.slice(2, 4)));
    }
    for (const offset of ["", "-1", "NaN"]) {
      expect(ids(await events({ ...mode, limit: "2", offset }))).toEqual(ids(rows.slice(0, 2)));
    }
    expect(
      ids(await events({ ...mode, limit: "2", offset: "1", before_ts: "opaque-0003" })),
    ).toEqual(ids(rows.slice(1, 3)));
    expect(ids(await events({ ...mode, limit: "2", before_ts: "" }))).toEqual(
      ids(rows.slice(0, 2)),
    );
    expect(ids(await events({ ...mode, limit: "2", types: " ,agent-response, " }))).toEqual([
      "event-0001",
      "event-0003",
    ]);
  },
);

test("GET /chains/messages uses first values of repeated query parameters", async () => {
  seed(numberedRows(4));
  const query = new URLSearchParams({
    conversation_id: conversationId,
    tail: "true",
    limit: "1",
    offset: "0",
  });
  query.append("conversation_id", "foreign");
  query.append("tail", "invalid");
  query.append("limit", "501");
  query.append("offset", "1");
  const response = chainsMessagesRoute(
    new Request(`http://localhost/chains/messages?${query.toString()}`),
    services,
  );
  expect(response.status).toBe(200);
  expect(ids(((await response.json()) as { events: Message[] }).events)).toEqual(["event-0003"]);
});
