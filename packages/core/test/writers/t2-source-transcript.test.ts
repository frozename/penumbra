import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { TestEmbedder } from "@src/testing/index.js";
import { T2Promotion, type T2PromotionOpts } from "@src/writers/t2.js";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE t1_rollups(rollup_id TEXT,session_id TEXT,project_id TEXT,user_id TEXT,started_at TEXT,ended_at TEXT,origin TEXT,failed_promotion_attempts INTEGER DEFAULT 0,t2_promoted_at TEXT,promotion_filtered_at TEXT);
    CREATE TABLE t0_events(event_type TEXT,payload_summary TEXT,payload_json TEXT,session_id TEXT,ts TEXT);
    INSERT INTO t1_rollups VALUES('r','s','p','u','2026-11-01','2026-11-01',NULL,0,NULL,NULL)`);
});
afterEach(() => {
  db.close();
});

function seed(payload: unknown, summary = "Short activity summary"): void {
  db.run("INSERT INTO t0_events VALUES('agent-response',?,?,'s','2026-11-01')", [
    summary,
    JSON.stringify(payload),
  ]);
}

async function capture(options: Partial<T2PromotionOpts> = {}): Promise<string> {
  let input = "";
  const promotion = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-11-13"),
    uuid: (): string => "capture",
    minTranscriptChars: 0,
    sourceTranscript: true,
    ...options,
    llm: (text): Promise<never> => {
      input = text;
      throw new Error("captured");
    },
  });
  try {
    await promotion.promoteRollup("r");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "captured") throw error;
  }
  return input;
}

test("source mode uses message text beyond a truncated summary and preserves paragraphs", async () => {
  const body =
    "Opening context.\n\nThe durable lesson lives beyond the summary boundary.\nUse a source quote.";
  seed({ text: body }, body.slice(0, 16));
  expect(await capture()).toBe("Assistant: " + body);
});

test("source mode joins all text blocks without tool arguments or reasoning", async () => {
  seed({
    response: [
      { type: "text", text: "First paragraph." },
      { type: "tool_use", text: "SECRET TOOL ARGUMENT", input: { token: "secret" } },
      { type: "thinking", thinking: "PRIVATE REASONING" },
      { type: "text", text: "Second paragraph." },
    ],
  });
  expect(await capture()).toBe("Assistant: First paragraph.\n\nSecond paragraph.");
});

test("source mode reads nested message content before an excerpt", async () => {
  seed({
    message_excerpt: "Excerpt",
    message: { content: [{ type: "text", text: "Complete message." }] },
  });
  expect(await capture()).toBe("Assistant: Complete message.");
});

test("source mode falls back to summary for malformed or non-text payloads", async () => {
  seed({ tool: { text: "Not message content" } }, "Useful summary");
  expect(await capture()).toBe("Assistant: Useful summary");
  db.run("UPDATE t0_events SET payload_json='{' ");
  expect(await capture()).toBe("Assistant: Useful summary");
});

test("source mode reapplies private-tag stripping without reviving a summary of hidden content", async () => {
  seed({ text: "<private>secret lesson</private>" }, "secret lesson");
  expect(await capture()).toBe("");
});

test("source mode keeps a middle lesson beyond the old 20k head/tail cut", async () => {
  const body = "a".repeat(12_000) + "\nThe critical middle lesson.\n" + "z".repeat(12_000);
  seed({ text: body });
  expect(await capture({ maxTranscriptChars: 30_000 })).toBe("Assistant: " + body);
});

test("source mode rejects excess input instead of silently removing evidence", async () => {
  seed({ text: "x".repeat(200) });
  let error: unknown;
  try {
    await capture({ maxTranscriptChars: 100 });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("source transcript exceeds character budget");
  expect(
    db.query<{ n: number }, []>("SELECT failed_promotion_attempts AS n FROM t1_rollups").get()?.n,
  ).toBe(1);
});

test("legacy default retains summary-first behavior", async () => {
  seed({ text: "Complete raw message." }, "Existing summary");
  expect(await capture({ sourceTranscript: false })).toBe("Assistant: Existing summary");
});
