import { DispatchEventLog, HandoffWriter, loadSqliteVec, migrate, T0Writer } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { readFanoutHopEvidence } from "./fanout-hop-evidence.js";
import { runFanout } from "./fanout.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function seedHandoff(
  db: Database,
  input: {
    handoffId: string;
    parentHandoffId?: string | null;
    rootHandoffId?: string;
    branchName?: string | null;
    branchBase?: string | null;
    message?: string;
    triggeredByEventId?: string | null;
    ts?: string;
    trustworthy?: boolean;
  },
): void {
  const handoffs = new HandoffWriter({ db });
  const events = new DispatchEventLog(db);
  const ts = input.ts ?? "2026-09-12T10:00:00.000Z";
  handoffs.createApproved({
    handoff_id: input.handoffId,
    ts,
    project_id: "project-one",
    conversation_id: "conversation-1",
    from: "workflow",
    to: `${input.handoffId}-agent`,
    to_role: "executor",
    message: input.message ?? `${input.handoffId} task`,
    triggered_by_event_id: input.triggeredByEventId ?? null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: 4,
    chain_trust_mode: "all",
    chain_task_type: "implement_small",
    use_worktree: true,
    parent_handoff_id: input.parentHandoffId ?? null,
    branch_base: input.branchBase ?? "main",
    branch_name: input.branchName ?? `${input.handoffId}-branch`,
  });
  if (input.rootHandoffId !== undefined) {
    db.query("UPDATE handoffs SET root_handoff_id = ? WHERE handoff_id = ?").run(
      input.rootHandoffId,
      input.handoffId,
    );
  }
  expect(handoffs.claimDispatch(input.handoffId, `${input.handoffId}-worker`)).toBe(true);
  expect(
    handoffs.markCompleted(input.handoffId, {
      ts: "2026-09-12T10:10:00.000Z",
      expected_worker_id: `${input.handoffId}-worker`,
    }),
  ).toBe(true);
  events.recordBatch([
    {
      handoff_id: input.handoffId,
      source: "worker",
      kind: "dispatch.start",
      ts: "2026-09-12T10:00:01.000Z",
    },
    {
      handoff_id: input.handoffId,
      source: "worker",
      kind: "proc.spawn",
      ts: "2026-09-12T10:00:02.000Z",
    },
    {
      handoff_id: input.handoffId,
      source: "worker",
      kind: "dispatch.end",
      ts: "2026-09-12T10:00:09.000Z",
      meta: {
        committed: input.trustworthy !== false,
        worktree_changed: input.trustworthy !== false,
      },
    },
  ]);
}

function writeEvent(
  db: Database,
  input: {
    eventId: string;
    type: "agent-response" | "user-prompt";
    payload: Record<string, unknown>;
    ts?: string;
  },
): void {
  const ts = input.ts ?? "2026-09-12T10:00:08.000Z";
  new T0Writer(db).write({
    event_id: input.eventId,
    ts,
    ingest_ts: ts,
    source: "agentchat",
    source_detail: "worker",
    project_id: "project-one",
    user_id: "test-user",
    machine_id: "test-machine",
    session_id: "conversation-1",
    event_type: input.type,
    lane: "cli-subscription",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: input.payload,
    payload_summary: input.type,
    origin: "dispatch",
  });
}

function seedResponse(db: Database, handoffId = "root-h"): void {
  writeEvent(db, {
    eventId: `response-${handoffId}`,
    type: "agent-response",
    payload: { response: `${handoffId} output`, handoff_id: handoffId, agent: "worker" },
  });
}

function read(db: Database) {
  return readFanoutHopEvidence(db, {
    conversationId: "conversation-1",
    rootHandoffId: "root-h",
    provisionalBranchName: "provisional-root",
  });
}

test("reports trustworthy root and untrustworthy latest child independently through runFanout", async () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h", branchName: "root-real-branch" });
    seedHandoff(db, {
      handoffId: "child-h",
      parentHandoffId: "root-h",
      branchName: "child-real-branch",
      branchBase: "root-real-branch",
      trustworthy: false,
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db);

    const fanout = await runFanout(
      {
        dispatch: async () => ({ conversation_id: "unused", handoff_id: "unused" }),
        awaitChain: async () => ({
          status: "completed",
          final_agent: "root-agent",
          response_text: "authoritative root output",
        }),
        cancel: async () => {},
        fileWrite: async (path) => path,
        db: () => db,
        config: {},
        cwd: "/repo",
        storageRoot: "/storage",
        project: "project-one",
        args: {},
        chainStart: async () =>
          Response.json({
            conversation_id: "conversation-1",
            handoff_id: "root-h",
            branch_name: "stale-provisional",
          }),
      },
      { defaults: { timeout_ms: 10_000 }, tasks: [{ message: "review" }] },
    );

    expect(fanout.results[0]).toMatchObject({
      ok: true,
      response_text: "authoritative root output",
      handoff_id: "root-h",
      root_handoff_id: "root-h",
      latest_handoff_id: "child-h",
      branch_name: "root-real-branch",
      reliability_status: "complete",
      reliability_trustworthy: true,
      reliability_action: "accept",
      latest_reliability_status: "no_worktree_activity",
      latest_reliability_trustworthy: false,
      latest_reliability_action: "review_manually",
    });
  } finally {
    db.close();
  }
});

test("reports untrustworthy root and trustworthy latest child independently", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h", trustworthy: false });
    seedHandoff(db, {
      handoffId: "child-h",
      parentHandoffId: "root-h",
      trustworthy: true,
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db);

    expect(read(db)).toMatchObject({
      latest_handoff_id: "child-h",
      reliability_status: "no_worktree_activity",
      reliability_trustworthy: false,
      reliability_action: "review_manually",
      latest_reliability_status: "complete",
      latest_reliability_trustworthy: true,
      latest_reliability_action: "accept",
    });
  } finally {
    db.close();
  }
});

test("uses the root as both reliability subjects for a healthy single-root chain", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h" });
    seedResponse(db);

    expect(read(db)).toMatchObject({
      latest_handoff_id: "root-h",
      hop_count: 1,
      extra_hops: 0,
      hops_incomplete: false,
      reliability_status: "complete",
      reliability_trustworthy: true,
      reliability_action: "accept",
      latest_reliability_status: "complete",
      latest_reliability_trustworthy: true,
      latest_reliability_action: "accept",
    });
  } finally {
    db.close();
  }
});

test("returns unknown latest evidence when the requested root is absent", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "conversation-sibling", ts: "2026-09-12T10:02:00.000Z" });
    seedResponse(db, "conversation-sibling");

    expect(read(db)).toMatchObject({
      latest_handoff_id: null,
      hop_count: null,
      hops: null,
      branch_name: "provisional-root",
      reliability_status: null,
      reliability_trustworthy: null,
      reliability_action: null,
      latest_reliability_status: null,
      latest_reliability_trustworthy: null,
      latest_reliability_action: null,
    });
  } finally {
    db.close();
  }
});

test("ignores an unrelated later root and its retry chatter in the same conversation", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h" });
    seedHandoff(db, {
      handoffId: "child-h",
      parentHandoffId: "root-h",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedHandoff(db, { handoffId: "sibling-root", ts: "2026-09-12T10:02:00.000Z" });
    writeEvent(db, {
      eventId: "sibling-retry-chatter",
      type: "user-prompt",
      payload: {
        prompt: "[silent-failure-retry] retry_of=sibling-root prior_agent=sibling\n\nretry",
      },
      ts: "2026-09-12T10:03:00.000Z",
    });
    seedResponse(db);

    expect(read(db)).toMatchObject({
      latest_handoff_id: "child-h",
      hop_count: 2,
      retry_prompt_count: 0,
      hops_incomplete: false,
      latest_reliability_trustworthy: true,
    });
  } finally {
    db.close();
  }
});

test("uses linked canonical retry prompt provenance for actual parentless retry persistence", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h" });
    writeEvent(db, {
      eventId: "retry-prompt",
      type: "user-prompt",
      payload: {
        prompt: "[silent-failure-retry] retry_of=root-h prior_agent=root-h-agent\n\nroot task",
      },
      ts: "2026-09-12T10:00:50.000Z",
    });
    seedHandoff(db, {
      handoffId: "retry-h",
      parentHandoffId: null,
      triggeredByEventId: "retry-prompt",
      message:
        "## Relevant prior context\n\ncontext\n\n[silent-failure-retry] retry_of=root-h prior_agent=root-h-agent\n\nroot task",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db);

    const result = read(db);
    expect(result).toMatchObject({
      latest_handoff_id: "retry-h",
      hop_count: 2,
      extra_hops: 1,
      retry_prompt_count: 1,
      hops_incomplete: false,
      latest_reliability_trustworthy: true,
    });
    expect(result.hops?.find((hop) => hop.handoff_id === "retry-h")?.is_retry).toBe(true);
  } finally {
    db.close();
  }
});

test("does not invent a latest candidate for incomplete retry evidence", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h" });
    writeEvent(db, {
      eventId: "retry-without-handoff",
      type: "user-prompt",
      payload: {
        prompt: "[silent-failure-retry] retry_of=root-h prior_agent=root-h-agent\n\nroot task",
      },
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db);

    expect(read(db)).toMatchObject({
      latest_handoff_id: null,
      hop_count: 1,
      retry_prompt_count: 1,
      hops_incomplete: true,
      reliability_trustworthy: true,
      latest_reliability_status: null,
      latest_reliability_trustworthy: null,
      latest_reliability_action: null,
    });
  } finally {
    db.close();
  }
});

test("does not invent a latest candidate for invalid ancestry or cycles", () => {
  for (const corruption of ["orphan", "cycle"] as const) {
    const db = freshDb();
    try {
      seedHandoff(db, { handoffId: "root-h" });
      seedHandoff(db, {
        handoffId: "child-a",
        parentHandoffId: "root-h",
        rootHandoffId: "root-h",
        ts: "2026-09-12T10:01:00.000Z",
      });
      if (corruption === "orphan") {
        db.query("UPDATE handoffs SET parent_handoff_id = ? WHERE handoff_id = ?").run(
          "missing-parent",
          "child-a",
        );
      } else {
        seedHandoff(db, {
          handoffId: "child-b",
          parentHandoffId: "child-a",
          rootHandoffId: "root-h",
          ts: "2026-09-12T10:02:00.000Z",
        });
        db.query("UPDATE handoffs SET parent_handoff_id = ? WHERE handoff_id = ?").run(
          "child-b",
          "child-a",
        );
      }
      seedResponse(db);

      expect(read(db)).toMatchObject({
        latest_handoff_id: null,
        hops_incomplete: true,
        reliability_trustworthy: true,
        latest_reliability_status: null,
        latest_reliability_trustworthy: null,
        latest_reliability_action: null,
      });
    } finally {
      db.close();
    }
  }
});

test("does not qualify a unique leaf when the requested root cycles through a descendant", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h" });
    seedHandoff(db, {
      handoffId: "cycle-child",
      parentHandoffId: "root-h",
      rootHandoffId: "root-h",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "leaf-child",
      parentHandoffId: "root-h",
      rootHandoffId: "root-h",
      ts: "2026-09-12T10:02:00.000Z",
    });
    db.query("UPDATE handoffs SET parent_handoff_id = ? WHERE handoff_id = ?").run(
      "cycle-child",
      "root-h",
    );
    seedResponse(db);

    expect(read(db)).toMatchObject({
      latest_handoff_id: null,
      hop_count: 3,
      hops_incomplete: true,
      reliability_trustworthy: true,
      latest_reliability_status: null,
      latest_reliability_trustworthy: null,
      latest_reliability_action: null,
    });
  } finally {
    db.close();
  }
});

test("accepts a valid requested subtree below an ancestor outside that subtree", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "outer-root" });
    seedHandoff(db, {
      handoffId: "root-h",
      parentHandoffId: "outer-root",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "child-h",
      parentHandoffId: "root-h",
      ts: "2026-09-12T10:02:00.000Z",
    });
    seedResponse(db);

    const result = read(db);
    expect(result).toMatchObject({
      latest_handoff_id: "child-h",
      hop_count: 2,
      extra_hops: 1,
      hops_incomplete: false,
      parent_handoff_id: "outer-root",
      latest_reliability_trustworthy: true,
    });
    expect(result.hops?.map((hop) => hop.handoff_id)).toEqual(["root-h", "child-h"]);
  } finally {
    db.close();
  }
});

test("rejects a detached cycle attributed to the requested subtree owner", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "outer-root" });
    seedHandoff(db, {
      handoffId: "root-h",
      parentHandoffId: "outer-root",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "orphan-a",
      parentHandoffId: null,
      rootHandoffId: "outer-root",
      ts: "2026-09-12T10:02:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "orphan-b",
      parentHandoffId: "orphan-a",
      rootHandoffId: "outer-root",
      ts: "2026-09-12T10:03:00.000Z",
    });
    db.query("UPDATE handoffs SET parent_handoff_id = ? WHERE handoff_id = ?").run(
      "orphan-b",
      "orphan-a",
    );
    seedResponse(db);

    const rows = db
      .query<
        { handoff_id: string; parent_handoff_id: string | null; root_handoff_id: string | null },
        []
      >(
        `SELECT handoff_id, parent_handoff_id, root_handoff_id
         FROM handoffs
         WHERE handoff_id IN ('orphan-a', 'orphan-b')
         ORDER BY handoff_id`,
      )
      .all();
    expect(rows).toEqual([
      { handoff_id: "orphan-a", parent_handoff_id: "orphan-b", root_handoff_id: "outer-root" },
      { handoff_id: "orphan-b", parent_handoff_id: "orphan-a", root_handoff_id: "outer-root" },
    ]);

    const result = read(db);
    expect(result).toMatchObject({
      latest_handoff_id: null,
      hop_count: 1,
      hops_incomplete: true,
      reliability_trustworthy: true,
      latest_reliability_status: null,
      latest_reliability_trustworthy: null,
      latest_reliability_action: null,
    });
    expect(result.hops?.map((hop) => hop.handoff_id)).toEqual(["root-h"]);
  } finally {
    db.close();
  }
});

test("keeps healthy owner siblings and different-owner cycles outside the requested subtree", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "outer-root" });
    seedHandoff(db, {
      handoffId: "root-h",
      parentHandoffId: "outer-root",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "child-h",
      parentHandoffId: "root-h",
      ts: "2026-09-12T10:02:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "healthy-sibling",
      parentHandoffId: "outer-root",
      ts: "2026-09-12T10:03:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "unrelated-root",
      ts: "2026-09-12T10:04:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "unrelated-a",
      parentHandoffId: null,
      rootHandoffId: "unrelated-root",
      ts: "2026-09-12T10:05:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "unrelated-b",
      parentHandoffId: "unrelated-a",
      rootHandoffId: "unrelated-root",
      ts: "2026-09-12T10:06:00.000Z",
    });
    db.query("UPDATE handoffs SET parent_handoff_id = ? WHERE handoff_id = ?").run(
      "unrelated-b",
      "unrelated-a",
    );
    seedResponse(db);

    const result = read(db);
    expect(result).toMatchObject({
      latest_handoff_id: "child-h",
      hop_count: 2,
      extra_hops: 1,
      hops_incomplete: false,
      reliability_trustworthy: true,
      latest_reliability_trustworthy: true,
    });
    expect(result.hops?.map((hop) => hop.handoff_id)).toEqual(["root-h", "child-h"]);
  } finally {
    db.close();
  }
});

test("rejects a descendant with conflicting persisted root ownership", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h" });
    seedHandoff(db, {
      handoffId: "child-h",
      parentHandoffId: "root-h",
      ts: "2026-09-12T10:01:00.000Z",
    });
    db.query("UPDATE handoffs SET root_handoff_id = ? WHERE handoff_id = ?").run(
      "different-root",
      "child-h",
    );
    seedResponse(db);

    expect(read(db)).toMatchObject({
      latest_handoff_id: null,
      hop_count: 2,
      hops_incomplete: true,
      reliability_trustworthy: true,
      latest_reliability_status: null,
      latest_reliability_trustworthy: null,
      latest_reliability_action: null,
    });
  } finally {
    db.close();
  }
});

test("rejects conflicting explicit and canonical retry parents", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h" });
    seedHandoff(db, { handoffId: "other-root", ts: "2026-09-12T10:00:20.000Z" });
    writeEvent(db, {
      eventId: "retry-prompt",
      type: "user-prompt",
      payload: {
        prompt: "[silent-failure-retry] retry_of=root-h prior_agent=root-agent\n\nroot task",
      },
      ts: "2026-09-12T10:00:50.000Z",
    });
    seedHandoff(db, {
      handoffId: "conflicting-retry",
      parentHandoffId: "other-root",
      triggeredByEventId: "retry-prompt",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedResponse(db);

    const result = read(db);
    expect(result).toMatchObject({
      latest_handoff_id: null,
      hop_count: 1,
      retry_prompt_count: 1,
      hops_incomplete: true,
    });
    expect(result.hops?.map((hop) => hop.handoff_id)).toEqual(["root-h"]);
  } finally {
    db.close();
  }
});

test("rejects duplicate handoffs linked to one canonical retry prompt", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h" });
    writeEvent(db, {
      eventId: "retry-prompt",
      type: "user-prompt",
      payload: {
        prompt: "[silent-failure-retry] retry_of=root-h prior_agent=root-agent\n\nroot task",
      },
      ts: "2026-09-12T10:00:50.000Z",
    });
    for (const [handoffId, ts] of [
      ["retry-a", "2026-09-12T10:01:00.000Z"],
      ["retry-b", "2026-09-12T10:02:00.000Z"],
    ] as const) {
      seedHandoff(db, {
        handoffId,
        parentHandoffId: null,
        triggeredByEventId: "retry-prompt",
        ts,
      });
    }
    seedResponse(db);

    expect(read(db)).toMatchObject({
      latest_handoff_id: null,
      hop_count: 3,
      retry_prompt_count: 1,
      hops_incomplete: true,
    });
  } finally {
    db.close();
  }
});

test("does not choose between ambiguous descendant tips", () => {
  const db = freshDb();
  try {
    seedHandoff(db, { handoffId: "root-h" });
    seedHandoff(db, {
      handoffId: "child-a",
      parentHandoffId: "root-h",
      ts: "2026-09-12T10:01:00.000Z",
    });
    seedHandoff(db, {
      handoffId: "child-b",
      parentHandoffId: "root-h",
      ts: "2026-09-12T10:02:00.000Z",
    });
    seedResponse(db);

    expect(read(db)).toMatchObject({
      latest_handoff_id: null,
      hop_count: 3,
      extra_hops: 2,
      hops_incomplete: true,
      reliability_trustworthy: true,
      latest_reliability_status: null,
      latest_reliability_trustworthy: null,
      latest_reliability_action: null,
    });
  } finally {
    db.close();
  }
});
