import { LanesRecentResponseSchema } from "@penumbra/api-contract";
import {
  buildServices,
  loadSqliteVec,
  migrate,
  type RecallRequest,
  type RecallResult,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonFetchHandler } from "@src/serve.js";
import { runOrphanLanesSweep } from "@src/sweepers/orphan-lanes.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* ignored: best-effort darwin sqlite hint */
}

const noop = (): void => undefined;

// File-local widening: tests stub partial RecallResult fixtures because the
// /lanes/open route only reads id/title/body from recall hits. The schema's
// other required fields (tier, score, project_id, etc.) are noise here. A
// single documented widening at the test seam keeps fixtures concise.
function partialAs<T>(value: Partial<T>): T {
  return value as unknown as T;
}

beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

function startTestDaemon(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "lanes-route-"));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-23T12:00:00.000Z"),
  });
  services.watchdog = {
    recordHeartbeat: noop,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };

  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token });

  return {
    fetch: (path: string, init?: RequestInit): Promise<Response> =>
      handler(new Request(`http://x${path}`, init)),
    services,
    token,
    stop: (): void => {
      try {
        services.supervisor.stopAll();
      } catch {
        /* ignored: best-effort teardown */
      }
      try {
        db.close();
      } catch {
        /* ignored: best-effort teardown */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function authHeaders(token: string, headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...headers };
}

function postJson(
  daemon: ReturnType<typeof startTestDaemon>,
  path: string,
  body: unknown,
): Promise<Response> {
  return daemon.fetch(path, {
    method: "POST",
    headers: authHeaders(daemon.token, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function insertHandoff(
  daemon: ReturnType<typeof startTestDaemon>,
  handoffId: string,
  agent: string,
  opts: {
    parent_handoff_id?: string | null;
    root_handoff_id?: string | null;
    message?: string;
    project_id?: string | null;
  } = {},
): void {
  daemon.services.db
    .prepare(
      `
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id, parent_handoff_id, root_handoff_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      handoffId,
      "2026-04-23T12:00:00.000Z",
      opts.project_id ?? "proj",
      "conv",
      "maestro",
      agent,
      null,
      opts.message ?? "Task type: implement_small",
      "completed",
      "worker",
      "2026-04-23T12:01:00.000Z",
      `event-${handoffId}`,
      opts.parent_handoff_id ?? null,
      opts.root_handoff_id ?? handoffId,
    );
}

function insertPerformance(
  daemon: ReturnType<typeof startTestDaemon>,
  handoffId: string,
  agent: string,
): void {
  daemon.services.db
    .prepare(
      `
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
        gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used,
        latency_ms, source, notes, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      `perf-${handoffId}`,
      "2026-04-23T12:02:00.000Z",
      handoffId,
      "conv",
      "proj",
      agent,
      "implement_small",
      "merged",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "worker",
      null,
      "{}",
    );
}

interface LaneRow {
  lane_id: string;
  ts_opened: string;
  ts_closed: string | null;
  task_class: string;
  implementer_handoff: string;
  reviewer_handoff: string | null;
  gate_status: string;
  recalled_memory_ids: string[];
  recalled_query: string | null;
  override_reason: string | null;
  metadata_json: string;
}

test("open then close then recent returns lane with closed status", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-1", "codex");
    insertHandoff(daemon, "rev-1", "gemini");
    const opened = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-1",
      implementer_handoff: "h-1",
      task_class: "STANDARD",
    });
    expect(opened.status).toBe(200);
    const openBody = (await opened.json()) as {
      lane_id: string;
      ts_opened: string;
      gate_status: string;
    };
    expect(openBody.lane_id).toBe("lane-1");
    expect(openBody.gate_status).toBe("open");

    const closed = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-1",
      gate_status: "passed",
      reviewer_handoff: "rev-1",
    });
    expect(closed.status).toBe(200);
    const closeBody = (await closed.json()) as {
      lane_id: string;
      gate_status: string;
      ts_closed: string | null;
    };
    expect(closeBody.lane_id).toBe("lane-1");
    expect(closeBody.gate_status).toBe("passed");
    expect(closeBody.ts_closed).toBeTruthy();

    const recent = await daemon.fetch("/lanes/recent", { headers: authHeaders(daemon.token) });
    expect(recent.status).toBe(200);
    const recentBody = (await recent.json()) as {
      lanes: { lane_id: string; gate_status: string; ts_closed: string | null }[];
    };
    expect(recentBody.lanes).toHaveLength(1);
    expect(recentBody.lanes[0]?.lane_id).toBe("lane-1");
    expect(recentBody.lanes[0]?.gate_status).toBe("passed");
    expect(recentBody.lanes[0]?.ts_closed).toBeTruthy();
  } finally {
    daemon.stop();
  }
});

test("open creates a fresh lane when the latest lane for an implementer is closed", async () => {
  const daemon = startTestDaemon();
  try {
    const first = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-closed-first",
      implementer_handoff: "h-reopen",
      task_class: "BOUNDARY",
    });
    expect(first.status).toBe(200);

    const closed = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-closed-first",
      gate_status: "passed",
    });
    expect(closed.status).toBe(200);

    const reopened = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-reopened",
      implementer_handoff: "h-reopen",
      task_class: "BOUNDARY",
    });
    expect(reopened.status).toBe(200);
    const reopenedBody = (await reopened.json()) as {
      lane_id: string;
      gate_status: string;
      ts_closed: string | null;
    };
    expect(reopenedBody.lane_id).toBe("lane-reopened");
    expect(reopenedBody.gate_status).toBe("open");
    expect(reopenedBody.ts_closed).toBeNull();

    const laneCount = daemon.services.db
      .query<
        { c: number },
        [string]
      >("SELECT COUNT(*) AS c FROM lane_ledger WHERE implementer_handoff = ?")
      .get("h-reopen");
    expect(laneCount?.c).toBe(2);
  } finally {
    daemon.stop();
  }
});

test("manual open adopts the chain-start auto lane for the same implementer handoff", async () => {
  const daemon = startTestDaemon();
  try {
    const started = await postJson(daemon, "/chains/start", {
      initial_agent: "codex",
      message: "implement gated change",
      task_class: "BOUNDARY",
    });
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as { handoff_id: string; lane_id: string };
    insertPerformance(daemon, startedBody.handoff_id, "codex");

    const manualOpen = await postJson(daemon, "/lanes/open", {
      lane_id: "manual-lane",
      implementer_handoff: startedBody.handoff_id,
      task_class: "BOUNDARY",
    });
    expect(manualOpen.status).toBe(200);
    const manualOpenBody = (await manualOpen.json()) as { lane_id: string; adopted: boolean };
    expect(manualOpenBody.lane_id).toBe(startedBody.lane_id);
    expect(manualOpenBody.adopted).toBe(true);

    const closed = await postJson(daemon, "/lanes/close", {
      lane_id: manualOpenBody.lane_id,
      gate_status: "passed",
      metadata: { round_count: 2 },
    });
    expect(closed.status).toBe(200);

    const laneCount = daemon.services.db
      .query<
        { c: number },
        [string]
      >("SELECT COUNT(*) AS c FROM lane_ledger WHERE implementer_handoff = ?")
      .get(startedBody.handoff_id);
    expect(laneCount?.c).toBe(1);

    const perf = daemon.services.db
      .query<
        { gate_outcome: string | null },
        [string]
      >("SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?")
      .get(startedBody.handoff_id);
    expect(perf?.gate_outcome).toBe("passed");
  } finally {
    daemon.stop();
  }
});

test("close uses closed lineage rounds for the fallback round cap when metadata omits round_count", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-round-root", "codex", { root_handoff_id: "h-round-root" });
    insertHandoff(daemon, "h-round-child-1", "codex", {
      parent_handoff_id: "h-round-root",
      root_handoff_id: "h-round-root",
    });
    insertHandoff(daemon, "h-round-child-2", "codex", {
      parent_handoff_id: "h-round-child-1",
      root_handoff_id: "h-round-root",
    });
    insertHandoff(daemon, "h-round-child-3", "codex", {
      parent_handoff_id: "h-round-child-2",
      root_handoff_id: "h-round-root",
    });
    daemon.services.db
      .prepare(
        `
        INSERT INTO lane_ledger (
          lane_id, ts_opened, ts_closed, task_class, implementer_handoff, gate_status,
          recalled_memory_ids, recalled_query, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "lane-round-server-1",
        "2026-04-23T11:00:00.000Z",
        "2026-04-23T11:10:00.000Z",
        "BOUNDARY",
        "h-round-root",
        "failed",
        "[]",
        null,
        "{}",
      );
    daemon.services.db
      .prepare(
        `
        INSERT INTO lane_ledger (
          lane_id, ts_opened, ts_closed, task_class, implementer_handoff, gate_status,
          recalled_memory_ids, recalled_query, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "lane-round-server-2",
        "2026-04-23T11:20:00.000Z",
        "2026-04-23T11:30:00.000Z",
        "BOUNDARY",
        "h-round-child-1",
        "failed",
        "[]",
        null,
        "{}",
      );
    daemon.services.db
      .prepare(
        `
        INSERT INTO lane_ledger (
          lane_id, ts_opened, ts_closed, task_class, implementer_handoff, gate_status,
          recalled_memory_ids, recalled_query, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "lane-round-server-3",
        "2026-04-23T11:40:00.000Z",
        "2026-04-23T11:50:00.000Z",
        "BOUNDARY",
        "h-round-child-2",
        "failed",
        "[]",
        null,
        "{}",
      );
    daemon.services.db
      .prepare(
        `
        INSERT INTO lane_ledger (
          lane_id, ts_opened, task_class, implementer_handoff, gate_status,
          recalled_memory_ids, recalled_query, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "lane-round-server-4",
        "2026-04-23T12:00:00.000Z",
        "BOUNDARY",
        "h-round-child-3",
        "open",
        "[]",
        null,
        "{}",
      );

    const rejected = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-round-server-4",
      gate_status: "failed",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: {
        code: "round_count_exceeds_cap",
        message:
          "closed lane rounds for this handoff lineage must be <= 2 unless override_reason is present",
      },
    });

    const rejectedWithLowMetadata = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-round-server-4",
      gate_status: "failed",
      metadata: { round_count: 1 },
    });
    expect(rejectedWithLowMetadata.status).toBe(400);
    expect(await rejectedWithLowMetadata.json()).toEqual({
      error: {
        code: "round_count_exceeds_cap",
        message:
          "closed lane rounds for this handoff lineage must be <= 2 unless override_reason is present",
      },
    });

    const accepted = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-round-server-4",
      gate_status: "failed",
      override_reason: "manual approval for additional fix round",
    });
    expect(accepted.status).toBe(200);
  } finally {
    daemon.stop();
  }
});

test("close counts the currently open lane against the lineage round cap", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-round-cap-root", "codex", { root_handoff_id: "h-round-cap-root" });
    insertHandoff(daemon, "h-round-cap-child-1", "codex", {
      parent_handoff_id: "h-round-cap-root",
      root_handoff_id: "h-round-cap-root",
    });
    insertHandoff(daemon, "h-round-cap-child-2", "codex", {
      parent_handoff_id: "h-round-cap-child-1",
      root_handoff_id: "h-round-cap-root",
    });
    daemon.services.db
      .prepare(
        `
        INSERT INTO lane_ledger (
          lane_id, ts_opened, ts_closed, task_class, implementer_handoff, gate_status,
          recalled_memory_ids, recalled_query, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "lane-round-cap-1",
        "2026-04-23T11:00:00.000Z",
        "2026-04-23T11:10:00.000Z",
        "BOUNDARY",
        "h-round-cap-root",
        "failed",
        "[]",
        null,
        "{}",
      );
    daemon.services.db
      .prepare(
        `
        INSERT INTO lane_ledger (
          lane_id, ts_opened, ts_closed, task_class, implementer_handoff, gate_status,
          recalled_memory_ids, recalled_query, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "lane-round-cap-2",
        "2026-04-23T11:20:00.000Z",
        "2026-04-23T11:30:00.000Z",
        "BOUNDARY",
        "h-round-cap-child-1",
        "failed",
        "[]",
        null,
        "{}",
      );
    daemon.services.db
      .prepare(
        `
        INSERT INTO lane_ledger (
          lane_id, ts_opened, task_class, implementer_handoff, gate_status,
          recalled_memory_ids, recalled_query, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "lane-round-cap-open",
        "2026-04-23T12:00:00.000Z",
        "BOUNDARY",
        "h-round-cap-child-2",
        "open",
        "[]",
        null,
        "{}",
      );

    const rejected = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-round-cap-open",
      gate_status: "failed",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: {
        code: "round_count_exceeds_cap",
        message:
          "closed lane rounds for this handoff lineage must be <= 2 unless override_reason is present",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("closing a stale duplicate lane cannot regress a passed gate outcome to skipped", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-authoritative",
      implementer_handoff: "h-regress",
      task_class: "BOUNDARY",
    });
    insertHandoff(daemon, "h-regress", "codex");
    insertPerformance(daemon, "h-regress", "codex");

    const passed = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-authoritative",
      gate_status: "passed",
    });
    expect(passed.status).toBe(200);

    const reopened = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-stale-duplicate",
      implementer_handoff: "h-regress",
      task_class: "BOUNDARY",
    });
    expect(reopened.status).toBe(200);

    const skipped = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-stale-duplicate",
      gate_status: "skipped",
    });
    expect(skipped.status).toBe(200);

    const perf = daemon.services.db
      .query<
        { gate_outcome: string | null },
        [string]
      >("SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?")
      .get("h-regress");
    expect(perf?.gate_outcome).toBe("passed");
  } finally {
    daemon.stop();
  }
});

test("close rejects round_count over two unless override_reason is present", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-round-cap",
      implementer_handoff: "h-round-cap",
      task_class: "BOUNDARY",
    });

    const rejected = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-round-cap",
      gate_status: "failed",
      metadata: { round_count: 3 },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: {
        code: "round_count_exceeds_cap",
        message: "metadata.round_count must be <= 2 unless override_reason is present",
      },
    });

    const accepted = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-round-cap",
      gate_status: "failed",
      override_reason: "manual approval for additional fix round",
      metadata: { round_count: 3 },
    });
    expect(accepted.status).toBe(200);
  } finally {
    daemon.stop();
  }
});

test("close rejects same-agent self-review unless override_reason is present", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-impl-same", "codex");
    insertHandoff(daemon, "h-review-same", "codex");
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-self-review",
      implementer_handoff: "h-impl-same",
      task_class: "BOUNDARY",
    });

    const rejected = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-self-review",
      gate_status: "passed",
      reviewer_handoff: "h-review-same",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: {
        code: "same_agent_self_review",
        message:
          "reviewer_handoff must resolve to a different agent than implementer_handoff unless override_reason is present",
        implementer_agent: "codex",
        reviewer_agent: "codex",
      },
    });

    const accepted = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-self-review",
      gate_status: "passed",
      reviewer_handoff: "h-review-same",
      override_reason: "explicitly approved same-agent review",
    });
    expect(accepted.status).toBe(200);
  } finally {
    daemon.stop();
  }
});

test("close records an audit event when override_reason bypasses a guard", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-impl-override", "codex");
    insertHandoff(daemon, "h-review-override", "codex");
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-override-audit",
      implementer_handoff: "h-impl-override",
      task_class: "BOUNDARY",
    });

    const accepted = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-override-audit",
      gate_status: "passed",
      reviewer_handoff: "h-review-override",
      override_reason: "operator accepted same-agent review after manual inspection",
    });
    expect(accepted.status).toBe(200);

    const row = daemon.services.db
      .query<
        { kind: string; source: string; meta_json: string | null },
        [string]
      >("SELECT kind, source, meta_json FROM dispatch_events WHERE handoff_id = ?")
      .get("h-impl-override");
    expect(row?.kind).toBe("lane.override");
    expect(row?.source).toBe("daemon");
    const meta = JSON.parse(row?.meta_json ?? "{}") as unknown;
    expect(meta).toEqual({
      control: "same_agent_self_review",
      lane_id: "lane-override-audit",
      gate_status: "passed",
      override_reason: "operator accepted same-agent review after manual inspection",
    });
  } finally {
    daemon.stop();
  }
});

test("override close persists when audit event recording fails after commit", async () => {
  const daemon = startTestDaemon();
  const originalRecord = daemon.services.dispatchEventLog.record.bind(
    daemon.services.dispatchEventLog,
  );
  try {
    insertHandoff(daemon, "h-impl-override-rollback", "codex");
    insertHandoff(daemon, "h-review-override-rollback", "codex");
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-override-rollback",
      implementer_handoff: "h-impl-override-rollback",
      task_class: "BOUNDARY",
    });

    daemon.services.dispatchEventLog.record = (event): void => {
      if (event.kind === "lane.override") {
        throw new Error("audit write failed");
      }
      originalRecord(event);
    };

    // The close is the authoritative record and commits before audit events
    // publish (live-bus delivery cannot roll back). An audit failure is logged
    // but must not error a close that already persisted — surfacing it as an
    // error would be the write-then-error trap.
    const closed = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-override-rollback",
      gate_status: "passed",
      reviewer_handoff: "h-review-override-rollback",
      override_reason: "operator accepted same-agent review after manual inspection",
    });
    expect(closed.status).toBe(200);

    const lane = daemon.services.db
      .query<
        { gate_status: string; ts_closed: string | null },
        [string]
      >("SELECT gate_status, ts_closed FROM lane_ledger WHERE lane_id = ?")
      .get("lane-override-rollback");
    expect(lane?.gate_status).toBe("passed");
    expect(lane?.ts_closed).toBeTruthy();
    const auditCount = daemon.services.db
      .query<
        { c: number },
        [string]
      >("SELECT COUNT(*) AS c FROM dispatch_events WHERE handoff_id = ?")
      .get("h-impl-override-rollback");
    expect(auditCount?.c).toBe(0);
  } finally {
    daemon.services.dispatchEventLog.record = originalRecord;
    daemon.stop();
  }
});

test("close rejects an unknown reviewer_handoff instead of skipping the self-review check", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-impl-known", "codex");
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-unknown-reviewer",
      implementer_handoff: "h-impl-known",
      task_class: "BOUNDARY",
    });

    const rejected = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-unknown-reviewer",
      gate_status: "passed",
      reviewer_handoff: "h-no-such-handoff",
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: {
        code: "unknown_reviewer_handoff",
        message: "reviewer_handoff does not resolve to a known handoff",
        reviewer_handoff: "h-no-such-handoff",
      },
    });

    const accepted = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-unknown-reviewer",
      gate_status: "passed",
      reviewer_handoff: "h-no-such-handoff",
      override_reason: "reviewer ran outside the handoff system",
    });
    expect(accepted.status).toBe(200);
  } finally {
    daemon.stop();
  }
});

test("manual open with a mismatched task_class returns 409 instead of adopting the open lane", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-class-original",
      implementer_handoff: "h-class-mismatch",
      task_class: "TRIVIAL",
    });

    const mismatched = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-class-upgrade",
      implementer_handoff: "h-class-mismatch",
      task_class: "BOUNDARY",
    });
    expect(mismatched.status).toBe(409);
    expect(await mismatched.json()).toEqual({
      error: {
        code: "task_class_mismatch",
        message:
          "an open lane already exists for this implementer_handoff with a different task_class",
        existing_lane_id: "lane-class-original",
        existing_task_class: "TRIVIAL",
        requested_task_class: "BOUNDARY",
      },
    });

    const matching = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-class-same",
      implementer_handoff: "h-class-mismatch",
      task_class: "TRIVIAL",
    });
    expect(matching.status).toBe(200);
    const matchingBody = (await matching.json()) as { lane_id: string };
    expect(matchingBody.lane_id).toBe("lane-class-original");
  } finally {
    daemon.stop();
  }
});

test("manual open stores recalled_memory_ids from implementer handoff recall hits", async () => {
  const daemon = startTestDaemon();
  try {
    const recallArgs: RecallRequest[] = [];
    daemon.services.recallReader.recall = (args): Promise<RecallResult[]> => {
      recallArgs.push(args);
      return Promise.resolve([
        partialAs<RecallResult>({ id: "manual-m1", title: "manual memo 1", body: "first" }),
        partialAs<RecallResult>({ id: "manual-m2", title: "manual memo 2", body: "second" }),
      ]);
    };
    insertHandoff(daemon, "h-manual-recall", "codex", {
      message: "Fix lane memory authorization",
      project_id: "penumbra",
    });

    const opened = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-manual-recall",
      implementer_handoff: "h-manual-recall",
      task_class: "BOUNDARY",
    });

    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      lane_id: "lane-manual-recall",
      recalled_memory_ids: ["manual-m1", "manual-m2"],
      recalled_query: "Fix lane memory authorization task_class:BOUNDARY",
    });
    expect(recallArgs).toHaveLength(1);
    expect(recallArgs[0]).toMatchObject({
      query: "Fix lane memory authorization task_class:BOUNDARY",
      limit: 8,
      project_id: "penumbra",
    });
  } finally {
    daemon.stop();
  }
});

test("manual open stores empty recalled_memory_ids when implementer handoff recall has no hits", async () => {
  const daemon = startTestDaemon();
  try {
    daemon.services.recallReader.recall = (): Promise<RecallResult[]> => Promise.resolve([]);
    insertHandoff(daemon, "h-manual-no-recall", "codex", {
      message: "No matching memories",
      project_id: "penumbra",
    });

    const opened = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-manual-no-recall",
      implementer_handoff: "h-manual-no-recall",
      task_class: "STANDARD",
    });

    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      lane_id: "lane-manual-no-recall",
      recalled_memory_ids: [],
      recalled_query: "No matching memories task_class:STANDARD",
    });
  } finally {
    daemon.stop();
  }
});

test("a stale duplicate skipped close cannot regress a failed gate outcome", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-failed-authoritative",
      implementer_handoff: "h-failed-regress",
      task_class: "BOUNDARY",
    });
    insertHandoff(daemon, "h-failed-regress", "codex");
    insertPerformance(daemon, "h-failed-regress", "codex");

    const failed = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-failed-authoritative",
      gate_status: "failed",
    });
    expect(failed.status).toBe(200);

    const reopened = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-failed-stale-duplicate",
      implementer_handoff: "h-failed-regress",
      task_class: "BOUNDARY",
    });
    expect(reopened.status).toBe(200);

    const skipped = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-failed-stale-duplicate",
      gate_status: "skipped",
    });
    expect(skipped.status).toBe(200);

    const perf = daemon.services.db
      .query<
        { gate_outcome: string | null },
        [string]
      >("SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?")
      .get("h-failed-regress");
    expect(perf?.gate_outcome).toBe("failed");
  } finally {
    daemon.stop();
  }
});

test("open returns the full persisted lane row", async () => {
  const daemon = startTestDaemon();
  try {
    const opened = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-full-open",
      implementer_handoff: "h-full-open",
      task_class: "STANDARD",
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({
      lane_id: "lane-full-open",
      ts_opened: "2026-04-23T12:00:00.000Z",
      ts_closed: null,
      task_class: "STANDARD",
      implementer_handoff: "h-full-open",
      reviewer_handoff: null,
      gate_status: "open",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: null,
      metadata_json: "{}",
    } satisfies LaneRow);
  } finally {
    daemon.stop();
  }
});

test("close returns the closed lane payload even if the row disappears after update", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-close-null",
      implementer_handoff: "h-close-null",
      task_class: "STANDARD",
    });

    daemon.services.db
      .prepare(
        `
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        "h-close-null",
        "2026-04-23T12:00:00.000Z",
        "proj",
        "conv",
        "maestro",
        "claude",
        null,
        "Task type: implement_small",
        "completed",
        "worker",
        "2026-04-23T12:01:00.000Z",
        "event-close-null",
      );
    daemon.services.db
      .prepare(
        `
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
        gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used,
        latency_ms, source, notes, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        "perf-close-null",
        "2026-04-23T12:02:00.000Z",
        "h-close-null",
        "conv",
        "proj",
        "claude",
        "implement_small",
        "merged",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "worker",
        null,
        "{}",
      );

    daemon.services.db.run(`
      CREATE TRIGGER delete_lane_after_gate_outcome_update
      AFTER UPDATE OF gate_outcome ON agent_performance
      BEGIN
        DELETE FROM lane_ledger WHERE lane_id = 'lane-close-null';
      END;
    `);

    const closed = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-close-null",
      gate_status: "passed",
    });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({
      lane_id: "lane-close-null",
      ts_opened: "2026-04-23T12:00:00.000Z",
      ts_closed: "2026-04-23T12:00:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "h-close-null",
      reviewer_handoff: null,
      gate_status: "passed",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: null,
      metadata_json: "{}",
    } satisfies LaneRow);
  } finally {
    daemon.stop();
  }
});

test("duplicate lane_id returns 409", async () => {
  const daemon = startTestDaemon();
  try {
    expect(
      (
        await postJson(daemon, "/lanes/open", {
          lane_id: "lane-dup",
          implementer_handoff: "h-1",
          task_class: "STANDARD",
        })
      ).status,
    ).toBe(200);
    const dup = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-dup",
      implementer_handoff: "h-2",
      task_class: "STANDARD",
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({
      error: {
        code: "lane_already_exists",
        message: "lane_id already exists",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("close unknown lane returns 404", async () => {
  const daemon = startTestDaemon();
  try {
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "missing",
      gate_status: "passed",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        code: "unknown_lane",
        message: "lane_id does not exist",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("close twice returns 409 on second call", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-2",
      implementer_handoff: "h-1",
      task_class: "STANDARD",
    });
    const first = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-2",
      gate_status: "passed",
    });
    expect(first.status).toBe(200);
    const second = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-2",
      gate_status: "passed",
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: {
        code: "lane_already_closed",
        message: "lane is already closed",
      },
    });
  } finally {
    daemon.stop();
  }
});

test("close stamps gate_outcome onto matching agent performance row", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-stamp",
      implementer_handoff: "h-stamp",
      task_class: "STANDARD",
    });
    daemon.services.db
      .prepare(
        `
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        "h-stamp",
        "2026-04-23T12:00:00.000Z",
        "proj",
        "conv",
        "maestro",
        "claude",
        null,
        "Task type: implement_small",
        "completed",
        "worker",
        "2026-04-23T12:01:00.000Z",
        "event-stamp",
      );
    daemon.services.db
      .prepare(
        `
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
        gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used,
        latency_ms, source, notes, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        "perf-stamp",
        "2026-04-23T12:02:00.000Z",
        "h-stamp",
        "conv",
        "proj",
        "claude",
        "implement_small",
        "merged",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "worker",
        null,
        "{}",
      );

    const closed = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-stamp",
      gate_status: "failed",
    });
    expect(closed.status).toBe(200);

    const row = daemon.services.db
      .query<
        { gate_outcome: string | null },
        [string]
      >("SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?")
      .get("h-stamp");
    expect(row?.gate_outcome).toBe("failed");
  } finally {
    daemon.stop();
  }
});

test.each([
  ["passed", 0],
  ["failed", 0],
  ["skipped", 0],
  ["review_debt", 0],
] as const)(
  "close preserves gate_status=%s in telemetry and memory verify count",
  async (gateStatus, expectedVerificationEvents) => {
    const daemon = startTestDaemon();
    try {
      await postJson(daemon, "/lanes/open", {
        lane_id: `lane-${gateStatus}`,
        implementer_handoff: `h-${gateStatus}`,
        task_class: "STANDARD",
      });
      daemon.services.db
        .prepare(
          `
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message,
        status, resolved_by, resolved_at, triggered_by_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        )
        .run(
          `h-${gateStatus}`,
          "2026-04-23T12:00:00.000Z",
          "proj",
          "conv",
          "maestro",
          "claude",
          null,
          "Task type: implement_small",
          "completed",
          "worker",
          "2026-04-23T12:01:00.000Z",
          `event-${gateStatus}`,
        );
      daemon.services.db
        .prepare(
          `
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
        gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used,
        latency_ms, source, notes, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        )
        .run(
          `perf-${gateStatus}`,
          "2026-04-23T12:02:00.000Z",
          `h-${gateStatus}`,
          "conv",
          "proj",
          "claude",
          "implement_small",
          "merged",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          "worker",
          null,
          "{}",
        );
      daemon.services.db.run(
        `INSERT INTO t2_memories(
        memory_id, project_id, user_id, kind, source_session_ids,
        window_start, window_end, title, body, metadata_json,
        compressed_from, created_at, updated_at
      ) VALUES (?, NULL, 'u1', 'fact', '[]', ?, ?, ?, ?, '{}', NULL, ?, ?)`,
        [
          `m-${gateStatus}`,
          "2026-04-23T11:00:00.000Z",
          "2026-04-23T11:30:00.000Z",
          `m-${gateStatus}`,
          `m-${gateStatus} body`,
          "2026-04-23T11:30:00.000Z",
          "2026-04-23T11:30:00.000Z",
        ],
      );
      daemon.services.db.run(`UPDATE lane_ledger SET recalled_memory_ids=? WHERE lane_id=?`, [
        JSON.stringify([`m-${gateStatus}`]),
        `lane-${gateStatus}`,
      ]);

      const closed = await postJson(daemon, "/lanes/close", {
        lane_id: `lane-${gateStatus}`,
        gate_status: gateStatus,
      });
      expect(closed.status).toBe(200);

      const row = daemon.services.db
        .query<
          { gate_outcome: string | null },
          [string]
        >("SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?")
        .get(`h-${gateStatus}`);
      expect(row?.gate_outcome).toBe(gateStatus);

      const count = daemon.services.db
        .query<
          { c: number },
          []
        >("SELECT COUNT(*) AS c FROM t2_memory_verification_events WHERE session_id = ?")
        .get(`h-${gateStatus}`);
      expect(count?.c).toBe(expectedVerificationEvents);
    } finally {
      daemon.stop();
    }
  },
);

test("close rejects gate_status='open' with 400", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-3",
      implementer_handoff: "h-1",
      task_class: "STANDARD",
    });
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-3",
      gate_status: "open",
    });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

test("recent filters by status", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-open",
      implementer_handoff: "h-1",
      task_class: "STANDARD",
    });
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-passed",
      implementer_handoff: "h-2",
      task_class: "STANDARD",
    });
    await postJson(daemon, "/lanes/close", {
      lane_id: "lane-passed",
      gate_status: "passed",
    });

    const res = await daemon.fetch("/lanes/recent?status=passed", {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lanes: { lane_id: string }[] };
    expect(body.lanes.map((lane) => lane.lane_id)).toEqual(["lane-passed"]);
  } finally {
    daemon.stop();
  }
});

test("close with metadata persists serialized JSON to DB", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-meta",
      implementer_handoff: "h-meta",
      task_class: "BOUNDARY",
    });
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-meta",
      gate_status: "passed",
      metadata: { high_findings: 2, round_count: 2, reviewer_agent: "codex-acp-deep" },
    });
    expect(res.status).toBe(200);
    const row = daemon.services.db
      .query<
        { metadata_json: string },
        [string]
      >("SELECT metadata_json FROM lane_ledger WHERE lane_id = ?")
      .get("lane-meta");
    expect(row).toBeTruthy();
    const parsed = JSON.parse(row?.metadata_json ?? "{}") as unknown;
    expect(parsed).toEqual({
      high_findings: 2,
      round_count: 2,
      reviewer_agent: "codex-acp-deep",
    });
  } finally {
    daemon.stop();
  }
});

test("close with unknown metadata key returns 400", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-strict",
      implementer_handoff: "h-strict",
      task_class: "STANDARD",
    });
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-strict",
      gate_status: "passed",
      metadata: { invented_field: "x" },
    });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

test("close with oversized metadata returns 400 metadata_too_large", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-oversize",
      implementer_handoff: "h-oversize",
      task_class: "STANDARD",
    });
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-oversize",
      gate_status: "passed",
      metadata: { notes: "x".repeat(5000) },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("metadata_too_large");
  } finally {
    daemon.stop();
  }
});

test("close with multi-byte oversized metadata returns 400 (byte-count semantics)", async () => {
  const daemon = startTestDaemon();
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-multibyte",
      implementer_handoff: "h-multibyte",
      task_class: "STANDARD",
    });
    // Each '😀' is 4 UTF-8 bytes but only 2 UTF-16 code units.
    // 1100 repetitions = 2200 .length but 4400 bytes — exceeds the 4096-byte limit.
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-multibyte",
      gate_status: "passed",
      metadata: { notes: "😀".repeat(1100) },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("metadata_too_large");
  } finally {
    daemon.stop();
  }
});

test("recent limit is capped at 200", async () => {
  const daemon = startTestDaemon();
  try {
    for (let i = 0; i < 3; i++) {
      await postJson(daemon, "/lanes/open", {
        lane_id: `lane-${String(i)}`,
        implementer_handoff: `h-${String(i)}`,
        task_class: "STANDARD",
      });
    }

    const res = await daemon.fetch("/lanes/recent?limit=999", {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lanes: unknown[] };
    expect(body.lanes).toHaveLength(3);

    const capped = await daemon.fetch("/lanes/recent?limit=200", {
      headers: authHeaders(daemon.token),
    });
    expect(capped.status).toBe(200);
  } finally {
    daemon.stop();
  }
});

// GH #118 — ?since= offset normalization
test("GET /lanes/recent?since= returns same lanes for UTC and offset-equivalent timestamps", async () => {
  const daemon = startTestDaemon();
  // clock() → '2026-04-23T12:00:00.000Z'; opened lane ts_opened = that value
  try {
    await postJson(daemon, "/lanes/open", {
      lane_id: "lane-since",
      implementer_handoff: "h-since",
      task_class: "STANDARD",
    });

    // 1 minute before the lane opened — plain UTC
    const resUtc = await daemon.fetch("/lanes/recent?since=2026-04-23T11%3A59%3A00Z", {
      headers: authHeaders(daemon.token),
    });
    expect(resUtc.status).toBe(200);
    const utcBody = (await resUtc.json()) as { lanes: unknown[] };

    // Same instant with +05:00 offset (raw string looks like a later date/time)
    const resOffset = await daemon.fetch("/lanes/recent?since=2026-04-23T16%3A59%3A00%2B05%3A00", {
      headers: authHeaders(daemon.token),
    });
    expect(resOffset.status).toBe(200);
    const offsetBody = (await resOffset.json()) as { lanes: unknown[] };

    expect(utcBody.lanes).toHaveLength(1);
    expect(offsetBody.lanes).toHaveLength(utcBody.lanes.length);
  } finally {
    daemon.stop();
  }
});

test("GET /lanes/recent response safeParses LanesRecentResponseSchema", async () => {
  const daemon = startTestDaemon();
  try {
    const opened = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-schema-pin",
      implementer_handoff: "h-schema-pin",
      task_class: "STANDARD",
    });

    const res = await daemon.fetch("/lanes/recent", { headers: authHeaders(daemon.token) });
    expect(res.status).toBe(200);
    expect(opened.status).toBe(200);
    const body = await res.json();
    const parsed = LanesRecentResponseSchema.parse(body);
    expect(parsed.lanes).toHaveLength(1);
    expect(parsed.lanes[0]?.lane_id).toBe("lane-schema-pin");
  } finally {
    daemon.stop();
  }
});

test("POST /lanes/close rejects gate_status maybe with validation_error", async () => {
  const daemon = startTestDaemon();
  try {
    const opened = await postJson(daemon, "/lanes/open", {
      lane_id: "lane-invalid-status",
      implementer_handoff: "h-invalid-status",
      task_class: "STANDARD",
    });
    expect(opened.status).toBe(200);
    const response = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-invalid-status",
      gate_status: "maybe",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "validation_error",
    );
  } finally {
    daemon.stop();
  }
});

test("real sweeper close can be superseded once with reviewer and audited prior verdict", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-swept", "codex");
    insertHandoff(daemon, "rev-swept", "gemini");
    insertPerformance(daemon, "h-swept", "codex");
    expect(
      (
        await postJson(daemon, "/lanes/open", {
          lane_id: "lane-swept",
          implementer_handoff: "h-swept",
          task_class: "BOUNDARY",
        })
      ).status,
    ).toBe(200);
    const sweepTime = "2026-04-25T12:00:00.000Z";
    expect(runOrphanLanesSweep(daemon.services, { nowIso: sweepTime }).closed).toBe(1);
    daemon.services.clock = (): Date => new Date("2026-04-25T13:00:00.000Z");
    const prior = daemon.services.db
      .query<
        { gate_status: string; ts_closed: string; override_reason: string },
        []
      >("SELECT gate_status, ts_closed, override_reason FROM lane_ledger WHERE lane_id='lane-swept'")
      .get();
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-swept",
      gate_status: "passed",
      reviewer_handoff: "rev-swept",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LaneRow & { superseded: unknown };
    expect(body.superseded).toEqual(prior);
    expect(body.gate_status).toBe("passed");
    expect(body.reviewer_handoff).toBe("rev-swept");
    expect(body.override_reason).toStartWith("superseded orphan-lane sweeper close (review_debt @");
    const metadata = JSON.parse(body.metadata_json) as { notes: string };
    expect(metadata.notes).toContain("superseded orphan-lane sweeper close");
    expect(
      daemon.services.db
        .query("SELECT gate_outcome FROM agent_performance WHERE handoff_id='h-swept'")
        .get(),
    ).toEqual({ gate_outcome: "passed" });
    const events = daemon.services.db
      .query<
        { meta_json: string },
        []
      >("SELECT meta_json FROM dispatch_events WHERE kind='lane.override'")
      .all();
    expect(events.map((e): unknown => JSON.parse(e.meta_json) as unknown)).toContainEqual(
      expect.objectContaining({
        control: "sweeper_close_superseded",
        prior_gate_status: "review_debt",
        prior_ts_closed: sweepTime,
        prior_override_reason: (prior as { override_reason: string }).override_reason,
      }),
    );
    const again = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-swept",
      gate_status: "passed",
      reviewer_handoff: "rev-swept",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "lane_already_closed" } });
  } finally {
    daemon.stop();
  }
});

test("a swept-then-superseded passed close cannot erase a real failed gate_outcome", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-failed-then-swept", "codex");
    insertHandoff(daemon, "rev-failed-then-swept", "gemini");
    insertPerformance(daemon, "h-failed-then-swept", "codex");

    // Round 1 closes with a real failed verdict.
    expect(
      (
        await postJson(daemon, "/lanes/open", {
          lane_id: "lane-failed-first",
          implementer_handoff: "h-failed-then-swept",
          task_class: "BOUNDARY",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(daemon, "/lanes/close", {
          lane_id: "lane-failed-first",
          gate_status: "failed",
        })
      ).status,
    ).toBe(200);
    const outcomeAfterFail = daemon.services.db
      .query<
        { gate_outcome: string | null },
        []
      >("SELECT gate_outcome FROM agent_performance WHERE handoff_id='h-failed-then-swept'")
      .get();
    expect(outcomeAfterFail).toEqual({ gate_outcome: "failed" });

    // Round 2's lane outlives the non-TRIVIAL grace and is swept to review_debt.
    expect(
      (
        await postJson(daemon, "/lanes/open", {
          lane_id: "lane-swept-after-failed",
          implementer_handoff: "h-failed-then-swept",
          task_class: "BOUNDARY",
        })
      ).status,
    ).toBe(200);
    expect(
      runOrphanLanesSweep(daemon.services, { nowIso: "2026-04-30T12:00:00.000Z" }).closed,
    ).toBe(1);
    const outcomeAfterSweep = daemon.services.db
      .query<
        { gate_outcome: string | null },
        []
      >("SELECT gate_outcome FROM agent_performance WHERE handoff_id='h-failed-then-swept'")
      .get();
    expect(outcomeAfterSweep).toEqual({ gate_outcome: "failed" });

    // Superseding the sweeper close to passed must not lift the failed verdict —
    // the same passed close on an un-swept lane would leave it failed.
    daemon.services.clock = (): Date => new Date("2026-04-30T13:00:00.000Z");
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "lane-swept-after-failed",
      gate_status: "passed",
      reviewer_handoff: "rev-failed-then-swept",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ gate_status: "passed" });
    const outcomeAfterSupersede = daemon.services.db
      .query<
        { gate_outcome: string | null },
        []
      >("SELECT gate_outcome FROM agent_performance WHERE handoff_id='h-failed-then-swept'")
      .get();
    expect(outcomeAfterSupersede).toEqual({ gate_outcome: "failed" });
  } finally {
    daemon.stop();
  }
});

test("two never-superseded swept lanes do not consume the real review round cap", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-two-sweeps", "codex");
    insertHandoff(daemon, "rev-two-sweeps", "gemini");
    for (const lane_id of ["swept-round-1", "swept-round-2"]) {
      expect(
        (
          await postJson(daemon, "/lanes/open", {
            lane_id,
            implementer_handoff: "h-two-sweeps",
            task_class: "BOUNDARY",
          })
        ).status,
      ).toBe(200);
      expect(
        runOrphanLanesSweep(daemon.services, { nowIso: "2026-04-25T12:00:00.000Z" }).closed,
      ).toBe(1);
    }
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "swept-round-2",
      gate_status: "passed",
      reviewer_handoff: "rev-two-sweeps",
      metadata: { round_count: 1 },
    });
    expect(res.status).toBe(200);
  } finally {
    daemon.stop();
  }
});

for (const gate_status of ["passed", "skipped"]) {
  test(`supersede to ${gate_status} without review evidence fails closed`, async () => {
    const daemon = startTestDaemon();
    try {
      insertHandoff(daemon, "h-no-evidence", "codex");
      await postJson(daemon, "/lanes/open", {
        lane_id: "swept-no-evidence",
        implementer_handoff: "h-no-evidence",
        task_class: "STANDARD",
      });
      expect(
        runOrphanLanesSweep(daemon.services, { nowIso: "2026-04-25T12:00:00.000Z" }).closed,
      ).toBe(1);
      const res = await postJson(daemon, "/lanes/close", {
        lane_id: "swept-no-evidence",
        gate_status,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: "supersede_requires_review_evidence" },
      });
    } finally {
      daemon.stop();
    }
  });
}

test("whitespace override cannot launder a swept lane into passed", async () => {
  const daemon = startTestDaemon();
  try {
    insertHandoff(daemon, "h-whitespace", "codex");
    await postJson(daemon, "/lanes/open", {
      lane_id: "swept-whitespace",
      implementer_handoff: "h-whitespace",
      task_class: "STANDARD",
    });
    expect(
      runOrphanLanesSweep(daemon.services, { nowIso: "2026-04-25T12:00:00.000Z" }).closed,
    ).toBe(1);
    const res = await postJson(daemon, "/lanes/close", {
      lane_id: "swept-whitespace",
      gate_status: "passed",
      override_reason: "   ",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "supersede_requires_review_evidence" },
    });
  } finally {
    daemon.stop();
  }
});
