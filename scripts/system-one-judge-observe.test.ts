import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { loadShadowInputs, observeInputs } from "./system-one-judge-observe.js";

test("historical observer accepts only exact body-hash matches and strips reasoning", () => {
  const db = new Database(":memory:");
  try {
    db.run(
      "CREATE TABLE t1_rollups (rollup_id TEXT, first_prompt_excerpt TEXT); CREATE TABLE judge_decisions (decision_id TEXT, subject_id TEXT, site TEXT, created_at TEXT, incumbent_json TEXT, jev_json TEXT)",
    );
    db.query("INSERT INTO t1_rollups VALUES (?,?)").run("r", "body");
    for (const [id, hash] of [
      ["good", createHash("sha256").update("body").digest("hex")],
      ["stale", "stale"],
    ])
      db.query("INSERT INTO judge_decisions VALUES (?,?,?,?,?,?)").run(
        id!,
        "r",
        "dream.p1.promotion",
        "2026-11-11",
        JSON.stringify({ votes: [{ promote: true, confidence: 0.9, rationale: "secret" }] }),
        JSON.stringify({ inputSha256: hash }),
      );
    const loaded = loadShadowInputs(db, { since: "2026-11-01", limit: 10 });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.decisionId).toBe("good");
    expect(JSON.stringify(loaded)).not.toContain("secret");
  } finally {
    db.close();
  }
});

test("dry observation never requests inference and preserves absence of labels", async () => {
  let calls = 0;
  const rows: unknown[] = [];
  const result = await observeInputs([], {
    live: false,
    config: { baseUrl: "http://127.0.0.1:18944", model: "nano", revision: "sha" },
    fetch: () => {
      calls++;
      throw new Error("network");
    },
    writeDecision: (row) => {
      rows.push(row);
    },
    intervalMs: 1,
    signal: new AbortController().signal,
  });
  expect(calls).toBe(0);
  expect(rows).toHaveLength(0);
  expect(result.status).toBe("not_run");
  expect(result).not.toHaveProperty("accuracy");
});

test("live replay records a failed attempt then recovery without leaking bodies", async () => {
  let calls = 0;
  const recorded: unknown[] = [];
  const input = {
    decisionId: "d",
    subjectId: "r",
    body: "private source",
    historicalAt: "2026-11-01",
    votes: [{ promote: false, confidence: 0.7 }],
  };
  const result = await observeInputs([input, { ...input, decisionId: "next" }], {
    live: true,
    config: { baseUrl: "http://127.0.0.1:18944", model: "nano", revision: "sha" },
    fetch: () => {
      calls++;
      if (calls === 1) return Promise.reject(new TypeError("runtime offline"));
      return Promise.resolve(
        Response.json({
          model: "nano",
          answers: { promote: { type: "noul", noul: 0.1 } },
          usage: { input_tokens: 2, output_tokens: 0 },
        }),
      );
    },
    writeDecision: (row) => {
      recorded.push(row);
    },
    intervalMs: 1,
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ attempted: 2, answered: 1, applied: false });
  expect(recorded[0]).toMatchObject({ failure: "transport", candidatePromote: null });
  expect(recorded[1]).toMatchObject({ failure: null, candidatePromote: false });
  expect(JSON.stringify(recorded)).not.toContain("private source");
  expect(JSON.stringify(recorded)).not.toContain("runtime offline");
});
