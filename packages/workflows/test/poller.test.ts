import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

import { loadSqliteVec, migrate } from "@penumbra/core";
import { buildRegistry } from "../src/registry.js";
import { computeStateMetrics, type GitLogSinceCounter } from "../src/poller.js";
import { evaluateStateThresholds } from "../src/triggers.js";

function freshDb() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

test("computeStateMetrics returns zeros on empty db", () => {
  const db = freshDb();
  const m = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    transcriptReader: () => null,
  });
  expect(m["pending-handoffs"]).toBe(0);
  expect(m["pending-review-lanes"]).toBe(0);
  expect(m["context-window-percent"]).toBe(0);
});

test("counts pending handoffs and computes queue-idle-min from latest dispatch.end", () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES ('h1', '2026-05-04T11:00:00Z', 'c1', 'a', 'b', 'msg1', 'pending');

    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES (1, 'h1', 'worker', 'dispatch.end', '2026-05-04T11:30:00Z', '{}');
  `);

  const m = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    transcriptReader: () => null,
  });
  expect(m["pending-handoffs"]).toBe(1);
  expect(m["queue-idle-min"]).toBe(30);
});

test("counts open review lanes across task classes", () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO lane_ledger (
      lane_id, ts_opened, ts_closed, task_class, implementer_handoff,
      reviewer_handoff, gate_status, recalled_memory_ids, recalled_query, override_reason, metadata_json
    ) VALUES (
      'lane-1', '2026-05-04T10:00:00Z', NULL, 'BOUNDARY', 'h1', NULL, 'open', '[]', NULL, NULL, '{}'
    ),
    (
      'lane-2', '2026-05-04T10:05:00Z', NULL, 'STANDARD', 'h2', NULL, 'open', '[]', NULL, NULL, '{}'
    ),
    (
      'lane-3', '2026-05-04T10:10:00Z', '2026-05-04T11:00:00Z', 'BOUNDARY', 'h3', NULL, 'passed', '[]', NULL, NULL, '{}'
    );
  `);

  const m = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    transcriptReader: () => null,
  });
  expect(m["pending-review-lanes"]).toBe(2);
});

function insertHandoffOutcome(db: Database, eventId: string, ts: string): void {
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id,
      user_id, machine_id, session_id, event_type, lane,
      provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)
  `,
  ).run(
    eventId,
    ts,
    ts,
    "agentchat",
    "workflows",
    "p",
    "u",
    "m",
    "s",
    "workflow.outcome",
    "local",
    JSON.stringify({ workflow_name: "session-handoff" }),
  );
}

test("commits-since-last-handoff is MAX_SAFE_INTEGER when no prior session-handoff outcome", () => {
  const db = freshDb();
  const m = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    transcriptReader: () => null,
  });
  expect(m["commits-since-last-handoff"]).toBe(Number.MAX_SAFE_INTEGER);
});

test("commits-since-last-handoff uses gitLogSince counter when prior outcome exists", () => {
  const db = freshDb();
  insertHandoffOutcome(db, "e1", "2026-05-04T10:00:00Z");

  const stub: GitLogSinceCounter = (since) => {
    expect(since).toBe("2026-05-04T10:00:00Z");
    return 3;
  };

  const m = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    gitLogSince: stub,
    transcriptReader: () => null,
  });
  expect(m["commits-since-last-handoff"]).toBe(3);
});

test("commits-since-last-handoff is MAX_SAFE_INTEGER when gitLogSince throws", () => {
  const db = freshDb();
  insertHandoffOutcome(db, "e1", "2026-05-04T10:00:00Z");

  const stub: GitLogSinceCounter = () => {
    throw new Error("git not available");
  };

  const m = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    gitLogSince: stub,
    transcriptReader: () => null,
  });
  expect(m["commits-since-last-handoff"]).toBe(Number.MAX_SAFE_INTEGER);
});

test("throwing gitLogSince still fires commits-since-last-handoff thresholds", async () => {
  const db = freshDb();
  insertHandoffOutcome(db, "e1", "2026-05-04T10:00:00Z");

  const stub: GitLogSinceCounter = () => {
    throw new Error("git not available");
  };

  const metrics = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    gitLogSince: stub,
    transcriptReader: () => null,
  });

  const root = mkdtempSync(join(tmpdir(), "poller-threshold-"));
  const playbooks = join(root, "playbooks");
  const workflows = join(root, "workflows");
  mkdirSync(join(playbooks, "threshold"), { recursive: true });
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    join(playbooks, "threshold", "playbook.md"),
    `---
name: threshold
description: d
triggers:
  - kind: state-threshold
    metric: commits-since-last-handoff
    op: ">"
    value: 100
recall: []
output:
  - kind: clipboard
run:
  kind: markdown-template
---
body
`,
  );

  try {
    const reg = await buildRegistry({ playbooksDir: playbooks, workflowsDir: workflows });
    const matched = evaluateStateThresholds(reg, metrics);
    expect(matched.map((s) => s.name)).toEqual(["threshold"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commits-since-last-handoff uses most recent session-handoff outcome ts", () => {
  const db = freshDb();
  insertHandoffOutcome(db, "e1", "2026-05-04T08:00:00Z");
  insertHandoffOutcome(db, "e2", "2026-05-04T11:00:00Z");
  insertHandoffOutcome(db, "e3", "2026-05-04T09:00:00Z");

  let receivedSince = "";
  const stub: GitLogSinceCounter = (since) => {
    receivedSince = since;
    return 7;
  };

  const m = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    gitLogSince: stub,
    transcriptReader: () => null,
  });
  expect(receivedSince).toBe("2026-05-04T11:00:00Z");
  expect(m["commits-since-last-handoff"]).toBe(7);
});

test("context-window-percent returns 50 with 100k tokens and default budget", () => {
  const db = freshDb();
  const m = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    transcriptReader: () => ({ estimatedTokens: 100_000 }),
  });
  expect(m["context-window-percent"]).toBe(50);
});

test("context-window-percent caps at 100", () => {
  const db = freshDb();
  const m = computeStateMetrics({
    db,
    now: () => new Date("2026-05-04T12:00:00Z"),
    transcriptReader: () => ({ estimatedTokens: 250_000 }),
  });
  expect(m["context-window-percent"]).toBe(100);
});
