import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { writeRoutingDecision } from "@src/routing/decision-log.js";
import {
  DEFAULT_PROFILE_AGREEMENT_TOLERANCE,
  fetchProfileReplayRows,
  replayTaskProfiles,
} from "@src/routing/profile-agreement.js";
import type { RoutingDecision, TaskProfile } from "@src/routing/schemas.js";
import {
  ROUTER_SCORED_AXES,
  type TaskProfileJudge,
  type TaskProfileJudgeResult,
} from "@src/routing/task-profile-judge.js";
import { profileTaskDeterministic } from "@src/routing/task-profile.js";
import type { AgentTaskType } from "@src/schemas/agent-performance.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const SINCE = "2026-08-01T00:00:00.000Z";
const UNTIL = "2026-08-31T00:00:00.000Z";
const TS = "2026-08-05T10:00:00.000Z";
const ROLE = "executor";
const CHAIN_TASK_TYPE: AgentTaskType = "debug_diagnose";
const PROMPT = "Diagnose the flaky router test regression and root cause the failure";
const RECALL_PREFIX =
  "## Relevant prior context\nThe following memories were auto-recalled at dispatch time.\n";

function makeDecision(
  taskProfile: TaskProfile,
  overrides: Partial<RoutingDecision> = {},
): RoutingDecision {
  return {
    selected: {
      agent: "quality-seat",
      provider: "openai",
      routeId: "openai:quality-seat",
    },
    taskProfile,
    score: 0.88,
    confidence: 0.8,
    alternatives: [],
    factors: [],
    fallbackChain: [],
    dataFreshness: {},
    explanation: [],
    routerSchemaVersion: "1",
    ...overrides,
  };
}

function insertT0Event(db: Database, opts: { eventId: string; ts: string; prompt: string }): void {
  db.prepare(
    `
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane,
        payload_json
      ) VALUES (?, ?, ?, 'test', 'user', 'machine', 'agent-message', 'lane', ?)
    `,
  ).run(opts.eventId, opts.ts, opts.ts, JSON.stringify({ prompt: opts.prompt }));
}

function insertHandoff(
  db: Database,
  opts: {
    handoffId: string;
    ts: string;
    eventId: string;
    prompt: string;
    chainTaskType: string | null;
  },
): void {
  db.prepare(
    `
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role,
        message, status, triggered_by_event_id, chain_task_type
      ) VALUES (?, ?, 'project', ?, 'maestro', 'quality-seat', ?, ?, 'resolved', ?, ?)
    `,
  ).run(
    opts.handoffId,
    opts.ts,
    `${opts.handoffId}-conversation`,
    ROLE,
    RECALL_PREFIX + opts.prompt,
    opts.eventId,
    opts.chainTaskType,
  );
}

function seedReplayRow(
  db: Database,
  opts: {
    handoffId: string;
    decisionId: string;
    ts: string;
    prompt?: string;
    recordedProfile?: TaskProfile;
    chainTaskType?: string | null;
  },
): TaskProfile {
  const prompt = opts.prompt ?? PROMPT;
  const chainTaskType = opts.chainTaskType === undefined ? CHAIN_TASK_TYPE : opts.chainTaskType;
  const recordedProfile =
    opts.recordedProfile ??
    profileTaskDeterministic(
      prompt,
      ROLE,
      chainTaskType !== null ? { taskType: chainTaskType as AgentTaskType } : {},
    );
  const eventId = `${opts.handoffId}-event`;
  insertT0Event(db, { eventId, ts: opts.ts, prompt });
  insertHandoff(db, {
    handoffId: opts.handoffId,
    ts: opts.ts,
    eventId,
    prompt,
    chainTaskType,
  });
  writeRoutingDecision(db, makeDecision(recordedProfile), {
    decisionId: opts.decisionId,
    ts: opts.ts,
    handoffId: opts.handoffId,
    mode: "live",
    applied: true,
    role: ROLE,
  });
  return recordedProfile;
}

function totalChanges(db: Database): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
}

describe("profile agreement replay", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  afterEach(() => {
    db.close();
  });

  test("fetchProfileReplayRows reads the raw t0 prompt, not the recall-injected handoff message", () => {
    const recorded = seedReplayRow(db, {
      handoffId: "handoff-1",
      decisionId: "decision-1",
      ts: TS,
    });

    const fetched = fetchProfileReplayRows(db, { since: SINCE, until: UNTIL });

    expect(fetched.skippedUnreadable).toBe(0);
    expect(fetched.rows).toHaveLength(1);
    const row = fetched.rows[0]!;
    expect(row.decisionId).toBe("decision-1");
    expect(row.handoffId).toBe("handoff-1");
    expect(row.prompt).toBe(PROMPT);
    expect(row.prompt).not.toContain("auto-recalled");
    expect(row.chainTaskType).toBe(CHAIN_TASK_TYPE);
    expect(row.role).toBe(ROLE);
    expect(row.recordedProfile).toEqual(recorded);
  });

  test("an invalid chain_task_type is counted unreadable while NULL still reads with no hint", () => {
    seedReplayRow(db, {
      handoffId: "handoff-1",
      decisionId: "decision-1",
      ts: TS,
      chainTaskType: "not_a_task_type",
    });
    seedReplayRow(db, {
      handoffId: "handoff-2",
      decisionId: "decision-2",
      ts: "2026-08-06T10:00:00.000Z",
      chainTaskType: null,
    });

    const fetched = fetchProfileReplayRows(db, { since: SINCE, until: UNTIL });

    expect(fetched.skippedUnreadable).toBe(1);
    expect(fetched.rows).toHaveLength(1);
    expect(fetched.rows[0]?.decisionId).toBe("decision-2");
    expect(fetched.rows[0]?.chainTaskType).toBeNull();
  });

  test("a stored profile that disagrees with the recomputed deterministic profile is input drift, not judged", async () => {
    const base = profileTaskDeterministic(PROMPT, ROLE, { taskType: CHAIN_TASK_TYPE });
    seedReplayRow(db, {
      handoffId: "handoff-1",
      decisionId: "decision-1",
      ts: TS,
      recordedProfile: { ...base, codingDemand: 0.99 },
    });

    let judgeCalls = 0;
    const judge: TaskProfileJudge = {
      profileTask: () => {
        judgeCalls++;
        return Promise.reject(new Error("model call attempted"));
      },
    };

    const fetched = fetchProfileReplayRows(db, { since: SINCE, until: UNTIL });
    const report = await replayTaskProfiles(fetched, { judge });

    expect(report.totalRows).toBe(1);
    expect(report.inputDrift).toBe(1);
    expect(report.judged).toBe(0);
    expect(report.rows).toHaveLength(0);
    expect(judgeCalls).toBe(0);
  });

  test("a stored profile whose taskTypes differ from the recomputed profile is input drift, not judged", async () => {
    const base = profileTaskDeterministic(PROMPT, ROLE, { taskType: CHAIN_TASK_TYPE });
    seedReplayRow(db, {
      handoffId: "handoff-1",
      decisionId: "decision-1",
      ts: TS,
      recordedProfile: { ...base, taskTypes: [...base.taskTypes, "multimodal"] },
    });

    let judgeCalls = 0;
    const judge: TaskProfileJudge = {
      profileTask: (): Promise<TaskProfileJudgeResult> => {
        judgeCalls++;
        return Promise.resolve({ profile: base, source: "jev" });
      },
    };

    const fetched = fetchProfileReplayRows(db, { since: SINCE, until: UNTIL });
    const report = await replayTaskProfiles(fetched, { judge });

    expect(report.inputDrift).toBe(1);
    expect(report.judged).toBe(0);
    expect(judgeCalls).toBe(0);
    expect(report.taskTypesExactMatch.compared).toBe(0);
  });

  test("jev deltas inside the tolerance agree and outside disagree, per-axis stats are reported", async () => {
    const recorded = seedReplayRow(db, {
      handoffId: "handoff-1",
      decisionId: "decision-1",
      ts: TS,
    });
    const candidate: TaskProfile = {
      ...recorded,
      codingDemand: Math.min(1, recorded.codingDemand + 0.1),
      costSensitivity: Math.min(1, recorded.costSensitivity + 0.4),
    };
    const judge: TaskProfileJudge = {
      profileTask: (): Promise<TaskProfileJudgeResult> =>
        Promise.resolve({ profile: candidate, source: "jev" }),
    };

    const fetched = fetchProfileReplayRows(db, { since: SINCE, until: UNTIL });
    const report = await replayTaskProfiles(fetched, { judge });

    expect(report.judged).toBe(1);
    expect(report.bySource).toEqual({ jev: 1, deterministic: 0, llm: 0 });
    expect(report.axes.map((axis) => axis.axis)).toEqual([...ROUTER_SCORED_AXES]);

    const coding = report.axes.find((axis) => axis.axis === "codingDemand")!;
    expect(coding.compared).toBe(1);
    expect(coding.agreed).toBe(1);
    expect(coding.agreementRate).toBe(1);
    expect(coding.meanAbsDelta).toBe(0.1);
    expect(coding.meanSignedDelta).toBe(0.1);

    const cost = report.axes.find((axis) => axis.axis === "costSensitivity")!;
    expect(cost.compared).toBe(1);
    expect(cost.agreed).toBe(0);
    expect(cost.agreementRate).toBe(0);
    expect(cost.meanAbsDelta).toBe(0.4);
    expect(cost.meanSignedDelta).toBe(0.4);

    expect(report.rows[0]?.decisionId).toBe("decision-1");
    expect(report.rows[0]?.source).toBe("jev");
    expect(report.rows[0]?.deltas?.codingDemand).toBe(0.1);
    expect(report.rows[0]?.deltas?.costSensitivity).toBe(0.4);
  });

  test("a deterministic fallback result counts its reason and is excluded from axis comparison", async () => {
    seedReplayRow(db, {
      handoffId: "handoff-1",
      decisionId: "decision-1",
      ts: TS,
    });
    const judge: TaskProfileJudge = {
      profileTask: (message, role, hints): Promise<TaskProfileJudgeResult> =>
        Promise.resolve({
          profile: profileTaskDeterministic(message, role, hints),
          source: "deterministic",
          fallbackReason: "confidence_below_floor",
        }),
    };

    const fetched = fetchProfileReplayRows(db, { since: SINCE, until: UNTIL });
    const report = await replayTaskProfiles(fetched, { judge });

    expect(report.judged).toBe(1);
    expect(report.bySource.deterministic).toBe(1);
    expect(report.fallbackReasons.confidence_below_floor).toBe(1);
    for (const axis of report.axes) {
      expect(axis.compared).toBe(0);
      expect(axis.agreed).toBe(0);
      expect(axis.agreementRate).toBeNull();
      expect(axis.meanAbsDelta).toBeNull();
    }
    expect(report.taskTypesExactMatch.compared).toBe(0);
    expect(report.rows[0]?.source).toBe("deterministic");
    expect(report.rows[0]?.fallbackReason).toBe("confidence_below_floor");
    expect(report.rows[0]?.deltas).toBeNull();
  });

  test("taskTypesExactMatch counts only candidates whose taskTypes equal the recorded ones", async () => {
    const recorded = seedReplayRow(db, {
      handoffId: "handoff-1",
      decisionId: "decision-1",
      ts: TS,
    });
    seedReplayRow(db, {
      handoffId: "handoff-2",
      decisionId: "decision-2",
      ts: "2026-08-06T10:00:00.000Z",
    });
    const results: TaskProfileJudgeResult[] = [
      { profile: recorded, source: "jev" },
      { profile: { ...recorded, taskTypes: ["research"] }, source: "jev" },
    ];
    let call = 0;
    const judge: TaskProfileJudge = {
      profileTask: (): Promise<TaskProfileJudgeResult> => Promise.resolve(results[call++]!),
    };

    const fetched = fetchProfileReplayRows(db, { since: SINCE, until: UNTIL });
    const report = await replayTaskProfiles(fetched, { judge });

    expect(report.judged).toBe(2);
    expect(report.taskTypesExactMatch).toEqual({ compared: 2, agreed: 1 });
  });

  test("replayTaskProfiles performs no writes", async () => {
    seedReplayRow(db, {
      handoffId: "handoff-1",
      decisionId: "decision-1",
      ts: TS,
    });
    const judge: TaskProfileJudge = {
      profileTask: (): Promise<TaskProfileJudgeResult> =>
        Promise.resolve({
          profile: profileTaskDeterministic(PROMPT, ROLE, { taskType: CHAIN_TASK_TYPE }),
          source: "jev",
        }),
    };

    const fetched = fetchProfileReplayRows(db, { since: SINCE, until: UNTIL });
    const changesBefore = totalChanges(db);
    await replayTaskProfiles(fetched, { judge });
    await replayTaskProfiles(fetched, { judge });

    expect(totalChanges(db)).toBe(changesBefore);
  });

  test("dryRunProfileReport shares the live report shape with nothing judged and a zero histogram", async () => {
    const recorded = seedReplayRow(db, {
      handoffId: "handoff-1",
      decisionId: "decision-1",
      ts: TS,
    });
    seedReplayRow(db, {
      handoffId: "handoff-2",
      decisionId: "decision-2",
      ts: "2026-08-06T10:00:00.000Z",
      recordedProfile: { ...recorded, codingDemand: 0.99 },
    });

    const fetched = fetchProfileReplayRows(db, { since: SINCE, until: UNTIL });
    const { dryRunProfileReport } = await import("@src/routing/profile-agreement.js");
    expect(dryRunProfileReport).toBeDefined();
    const report = dryRunProfileReport(fetched);

    expect(report.since).toBe(SINCE);
    expect(report.until).toBe(UNTIL);
    expect(report.tolerance).toBe(DEFAULT_PROFILE_AGREEMENT_TOLERANCE);
    expect(report.totalRows).toBe(2);
    expect(report.skippedUnreadable).toBe(0);
    expect(report.inputDrift).toBe(1);
    expect(report.judged).toBe(0);
    expect(report.bySource).toEqual({ jev: 0, deterministic: 0, llm: 0 });
    expect(report.fallbackReasons).toEqual({});
    expect(report.axes.map((axis) => axis.axis)).toEqual([...ROUTER_SCORED_AXES]);
    for (const axis of report.axes) {
      expect(axis.compared).toBe(0);
      expect(axis.agreed).toBe(0);
      expect(axis.agreementRate).toBeNull();
      expect(axis.meanAbsDelta).toBeNull();
      expect(axis.meanSignedDelta).toBeNull();
    }
    expect(report.taskTypesExactMatch).toEqual({ compared: 0, agreed: 0 });
    expect(report.candidateConfidenceHistogram).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(report.rows).toHaveLength(0);
  });
});
