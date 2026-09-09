import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js"; // Ensure to load vector extension if required by tests!
import { HandoffReader } from "@src/readers/handoff.js";
import { HandoffWriter } from "@src/writers/handoff.js";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;
let reader: HandoffReader;
let writer: HandoffWriter;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  writer = new HandoffWriter({ db });
  reader = new HandoffReader({ db });
});

interface SampleHandoffParams {
  handoff_id: string;
  ts: string;
  from: string;
  to: string;
  to_role: string | null;
  message: string;
  conversation_id: string;
  project_id: string | null;
  triggered_by_event_id: string;
}

const sampleParams = (id: string, conv: string): SampleHandoffParams => ({
  handoff_id: id,
  ts: `2026-04-25T20:00:0${id.slice(-1)}.000Z`,
  from: "claude",
  to: "gemini",
  to_role: null,
  message: `m-${id}`,
  conversation_id: conv,
  project_id: null,
  triggered_by_event_id: `e-${id}`,
});

test("listByStatus({statuses:['pending'], to_agent:'x'}) returns only to_agent x rows", () => {
  writer.create({ ...sampleParams("h-1", "c-a"), to: "x" });
  writer.create({ ...sampleParams("h-2", "c-a"), to: "y" });

  const rows = reader.listByStatus({ statuses: ["pending"], to_agent: "x" });
  expect(rows.map((h) => h.handoff_id)).toEqual(["h-1"]);
});

test("listPending({to_agent:'x'}) returns only to_agent x rows", () => {
  writer.create({ ...sampleParams("h-1", "c-a"), to: "x" });
  writer.create({ ...sampleParams("h-2", "c-a"), to: "y" });

  const rows = reader.listPending({ to_agent: "x" });
  expect(rows.map((h) => h.handoff_id)).toEqual(["h-1"]);
});
