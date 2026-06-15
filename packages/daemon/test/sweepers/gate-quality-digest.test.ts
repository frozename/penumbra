import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import type { AgentGateRateTrend } from "../../src/sweepers/gate-quality-digest.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

const NOW = new Date("2026-06-13T03:00:00.000Z");

describe("gate-quality-digest sweeper", () => {
  let db: Database;
  let services: Services;
  let dir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    dir = mkdtempSync(join(tmpdir(), "penumbra-gate-quality-digest-"));
    services = buildServices({
      env: {},
      input: {},
      storageRoot: dir,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: () => NOW,
      uuid: (() => {
        let n = 0;
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      })(),
    });
  });

  afterEach(() => {
    services.supervisor.stopAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes an idempotent time-window digest and keeps T2 writes gated off by default", async () => {
    seedLanes();
    seedAgentPerformance();

    const { runGateQualityDigestSweep } = await import("../../src/sweepers/gate-quality-digest.js");

    const first = await runGateQualityDigestSweep({ services, outDir: dir, now: () => NOW });

    expect(first.lanesProcessed).toBe(5);
    expect(first.malformedMetadata).toBe(1);
    expect(first.t2Writes).toBe(0);
    expect(first.digestPath).toBe(join(dir, "gate-quality-digest-2026-06-13.md"));
    expect(existsSync(first.digestPath)).toBe(true);

    const digest = readFileSync(first.digestPath, "utf8");
    expect(digest).toContain("# Gate Quality Digest - 2026-06-13");
    expect(digest).toContain("| passed | 1 |");
    expect(digest).toContain("| failed | 3 |");
    expect(digest).toContain("| skipped | 1 |");
    expect(digest).toContain("| dispatch-event-stream-gap | 2 |");
    expect(digest).toContain("| alpha\\|beta | implement\\|small | 66.7% | 0.0 pp |");
    expect(digest).toContain("Malformed lane metadata skipped: 1");
    const firstStat = statSync(first.digestPath).mtimeMs;

    const cursorRows = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM db_meta WHERE key LIKE '%cursor%'`)
      .get()!.n;
    expect(cursorRows).toBe(0);
    expect(countGateQualityDigestMemories()).toBe(0);

    const second = await runGateQualityDigestSweep({ services, outDir: dir, now: () => NOW });
    expect(second.lanesProcessed).toBe(0);
    expect(second.t2Writes).toBe(0);
    expect(readFileSync(first.digestPath, "utf8")).toBe(digest);
    expect(statSync(first.digestPath).mtimeMs).toBe(firstStat);
    expect(countGateQualityDigestMemories()).toBe(0);
  });

  it("does not read lane rows or run T2 writes again on same-day rerun", async () => {
    seedLanes();
    seedRecurringLanes(25, "dispatch-event-stream-gap");

    const { runGateQualityDigestSweep } = await import("../../src/sweepers/gate-quality-digest.js");
    const env = (key: string) => (key === "PENUMBRA_GATE_QUALITY_T2_WRITES" ? "true" : undefined);
    let laneReads = 0;
    const originalQuery = (db as any).query.bind(db);
    (db as any).query = (...args: any[]) => {
      const statement = originalQuery(...args);
      const sql = String(args[0]);
      if (sql.includes("FROM lane_ledger")) {
        return {
          ...statement,
          all: (...allArgs: any[]) => {
            laneReads += 1;
            return (statement as any).all(...allArgs);
          },
        };
      }
      return statement;
    };

    try {
      const first = await runGateQualityDigestSweep({
        services,
        outDir: dir,
        now: () => NOW,
        getEnv: env,
        recurrenceThreshold: 3,
      });
      const firstDigest = readFileSync(first.digestPath, "utf8");
      const firstMemoryCount = countGateQualityDigestMemories();
      const firstMtime = statSync(first.digestPath).mtimeMs;
      expect(laneReads).toBe(1);

      const second = await runGateQualityDigestSweep({
        services,
        outDir: dir,
        now: () => NOW,
        getEnv: env,
        recurrenceThreshold: 3,
      });

      expect(second.lanesProcessed).toBe(0);
      expect(second.t2Writes).toBe(0);
      expect(statSync(second.digestPath).mtimeMs).toBe(firstMtime);
      expect(readFileSync(second.digestPath, "utf8")).toBe(firstDigest);
      expect(laneReads).toBe(1);
      expect(countGateQualityDigestMemories()).toBe(firstMemoryCount);
    } finally {
      (db as any).query = originalQuery;
    }
  });

  it("counts gate status from the closed-lane window, not the opened-lane window", async () => {
    // A lane OPENED before the 24h cutoff but CLOSED inside the window must be
    // counted: the digest derives status counts from the same ts_closed-bounded
    // rows used for failure analysis, not an opened-lane snapshot. The old path
    // keyed off ts_opened and would have reported this lane as zero.
    db.exec(`
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff,
        gate_status, metadata_json
      ) VALUES (
        'lane-late-close', '2026-06-12T00:00:00.000Z', '2026-06-13T01:00:00.000Z',
        'STANDARD', 'handoff-late', 'review-late', 'passed', '{}'
      );
    `);

    const { runGateQualityDigestSweep } = await import("../../src/sweepers/gate-quality-digest.js");
    const result = await runGateQualityDigestSweep({ services, outDir: dir, now: () => NOW });

    expect(result.lanesProcessed).toBe(1);
    const digest = readFileSync(result.digestPath, "utf8");
    expect(digest).toContain("| passed | 1 |");
  });

  it("writes at most one bounded T2 memory per recurring failure class per day when enabled", async () => {
    seedRecurringLanes(
      25,
      "Dispatch Event Stream Gap With Extra Context That Should Be Trimmed Because The Signature Keeps Going Past The Slug Limit And Must Not Be Embedded Whole",
    );

    const { runGateQualityDigestSweep } = await import("../../src/sweepers/gate-quality-digest.js");
    const env = (key: string) => (key === "PENUMBRA_GATE_QUALITY_T2_WRITES" ? "true" : undefined);

    const first = await runGateQualityDigestSweep({
      services,
      outDir: dir,
      now: () => NOW,
      getEnv: env,
      recurrenceThreshold: 3,
    });
    const second = await runGateQualityDigestSweep({
      services,
      outDir: dir,
      now: () => NOW,
      getEnv: env,
      recurrenceThreshold: 3,
    });

    expect(first.t2Writes).toBe(1);
    expect(second.t2Writes).toBe(0);

    const rows = db
      .query<
        { slug: string | null; title: string; body: string; obs_type: string | null },
        []
      >(`SELECT slug, title, body, obs_type FROM t2_memories WHERE hook = 'gate-quality-digest'`)
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe(
      "gate-quality-digest-2026-06-13-dispatch-event-stream-gap-with-extra-context-that-should-be-trimmed-because-the-signature-keeps",
    );
    expect(rows[0]!.title).toBe(
      "Recurring gate failure: dispatch-event-stream-gap-with-extra-context-that-should-be-trimmed-because-the-signature-keeps-going-past-the-slug-limit-and-must-not-be-embedded-whole",
    );
    expect(rows[0]!.body).toContain("Observed 25 lanes with this failure signature");
    expect(rows[0]!.body).toContain("Lane IDs: lane-rec-00");
    expect(rows[0]!.body).toContain("lane-rec-19");
    expect(rows[0]!.body).not.toContain("lane-rec-20");
    expect(rows[0]!.body).toContain("5 more omitted");
    expect(rows[0]!.obs_type).toBe("discovery");
  });

  it("warns and caps the windowed lane read when the sweep reaches the row limit", async () => {
    seedMassiveLanes(5_001);
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];

    const { runGateQualityDigestSweep } = await import("../../src/sweepers/gate-quality-digest.js");

    const result = await runGateQualityDigestSweep({
      services,
      outDir: dir,
      now: () => NOW,
      log: {
        warn: (obj, msg) => warnings.push({ obj, msg }),
      },
      recurrenceThreshold: 6_000,
    });

    expect(result.lanesProcessed).toBe(5_000);
    expect(warnings).toEqual([
      {
        obj: { limit: 5000, windowHours: 24 },
        msg: "gate-quality-digest: closed-lane window truncated at row limit",
      },
    ]);
  });

  it("started sweepers keep independent in-flight state per instance", async () => {
    const otherDir = mkdtempSync(join(tmpdir(), "penumbra-gate-quality-digest-other-"));
    const { startGateQualityDigestSweeper } =
      await import("../../src/sweepers/gate-quality-digest.js");

    const stopA = startGateQualityDigestSweeper({ services, outDir: dir, now: () => NOW }, 10_000);
    const stopB = startGateQualityDigestSweeper(
      { services, outDir: otherDir, now: () => NOW },
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    stopA();
    stopB();

    expect(existsSync(join(dir, "gate-quality-digest-2026-06-13.md"))).toBe(true);
    expect(existsSync(join(otherDir, "gate-quality-digest-2026-06-13.md"))).toBe(true);
    rmSync(otherDir, { recursive: true, force: true });
  });

  it("documents the agent gate rate trend return shape", () => {
    const trend: AgentGateRateTrend = {
      agent_name: "alpha",
      task_type: "implement_small",
      currentRate: 0.5,
      previousRate: null,
      deltaPoints: null,
      samples: 1,
    };
    expect(trend.deltaPoints).toBeNull();
  });

  function seedLanes(): void {
    db.exec(`
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff,
        gate_status, metadata_json
      ) VALUES
        (
          'lane-old', '2026-06-11T00:00:00.000Z', '2026-06-11T00:10:00.000Z',
          'STANDARD', 'handoff-old', 'review-old', 'failed',
          '{"failure_signature":"outside-window"}'
        ),
        (
          'lane-pass', '2026-06-13T00:00:00.000Z', '2026-06-13T00:10:00.000Z',
          'STANDARD', 'handoff-pass', 'review-pass', 'passed', '{}'
        ),
        (
          'lane-fail-a', '2026-06-13T00:20:00.000Z', '2026-06-13T00:30:00.000Z',
          'BOUNDARY', 'handoff-fail-a', 'review-fail-a', 'failed',
          '{"review":{"findings":[{"severity":"HIGH","failure_signature":"dispatch-event-stream-gap","title":"Dispatch events vanish after reconnect"}]}}'
        ),
        (
          'lane-fail-b', '2026-06-13T00:40:00.000Z', '2026-06-13T00:50:00.000Z',
          'BOUNDARY', 'handoff-fail-b', 'review-fail-b', 'failed',
          '{"failure_signature":"dispatch-event-stream-gap","summary":"stream gap repeated"}'
        ),
        (
          'lane-malformed', '2026-06-13T01:00:00.000Z', '2026-06-13T01:10:00.000Z',
          'STANDARD', 'handoff-bad-json', 'review-bad-json', 'failed', '{not-json'
        ),
        (
          'lane-skipped', '2026-06-13T01:50:00.000Z', '2026-06-13T02:00:00.000Z',
          'TRIVIAL', 'handoff-skip', NULL, 'skipped', '{}'
        );
    `);
  }

  function seedAgentPerformance(): void {
    db.exec(`
      INSERT INTO agent_performance (
        performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type,
        outcome, gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score,
        cost_usd, tokens_used, latency_ms, exec_ms, framework_overhead_ms, source,
        agent_kind, metadata_json
      ) VALUES
        (
          'perf-prev-alpha', '2026-06-12T12:00:00.000Z', 'perf-handoff-prev-alpha', 'conv', 'proj',
          'alpha|beta', 'implement|small', 'merged', 'passed', 1, 'yes', 0, NULL,
          NULL, NULL, 1000, 900, 100, 'test', 'cli', '{}'
        ),
        (
          'perf-alpha-pass', '2026-06-13T00:20:00.000Z', 'perf-handoff-alpha-pass', 'conv', 'proj',
          'alpha|beta', 'implement|small', 'merged', 'passed', 1, 'yes', 0, NULL,
          NULL, NULL, 1000, 900, 100, 'test', 'cli', '{}'
        ),
        (
          'perf-alpha-fail', '2026-06-13T00:40:00.000Z', 'perf-handoff-alpha-fail', 'conv', 'proj',
          'alpha|beta', 'implement|small', 'merged', 'failed', 1, 'yes', 1, NULL,
          NULL, NULL, 1000, 900, 100, 'test', 'cli', '{}'
        );
    `);
  }

  function seedRecurringLanes(count: number, signature: string): void {
    const stmt = db.prepare(
      `INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff,
        gate_status, metadata_json
      ) VALUES (
        ?,
        '2026-06-13T00:05:00.000Z',
        '2026-06-13T00:10:00.000Z',
        'BOUNDARY',
        ?,
        ?,
        'failed',
        ?
      )`,
    );
    for (let idx = 0; idx < count; idx++) {
      const padded = String(idx).padStart(2, "0");
      stmt.run(
        `lane-rec-${padded}`,
        `handoff-rec-${padded}`,
        `reviewer-rec-${padded}`,
        JSON.stringify({ failure_signature: signature, lane: idx }),
      );
    }
  }

  function seedMassiveLanes(count: number): void {
    const stmt = db.prepare(
      `INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff,
        gate_status, metadata_json
      ) VALUES (
        ?,
        '2026-06-13T00:05:00.000Z',
        '2026-06-13T00:10:00.000Z',
        'BOUNDARY',
        ?,
        ?,
        'failed',
        '{"failure_signature":"dispatch-event-stream-gap"}'
      )`,
    );
    for (let idx = 0; idx < count; idx++) {
      stmt.run(`lane-bulk-${idx}`, `handoff-bulk-${idx}`, `reviewer-bulk-${idx}`);
    }
  }

  it("startGateQualityDigestSweeper: defers sweep when pressure guard enabled and provider is over threshold", async () => {
    const deferLogs: string[] = [];
    const { startGateQualityDigestSweeper } =
      await import("../../src/sweepers/gate-quality-digest.js");

    const stop = startGateQualityDigestSweeper(
      {
        services,
        outDir: dir,
        now: () => NOW,
        getEnv: (key) => (key === "PENUMBRA_GATE_QUALITY_PRESSURE_GUARD" ? "true" : undefined),
        checkPressure: () => true,
        log: { info: (_obj, msg) => deferLogs.push(msg) },
      },
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();

    expect(existsSync(join(dir, "gate-quality-digest-2026-06-13.md"))).toBe(false);
    expect(deferLogs.some((m) => m.includes("deferred"))).toBe(true);
  });

  it("startGateQualityDigestSweeper: runs normally when pressure guard enabled but pressure is low", async () => {
    const { startGateQualityDigestSweeper } =
      await import("../../src/sweepers/gate-quality-digest.js");

    const stop = startGateQualityDigestSweeper(
      {
        services,
        outDir: dir,
        now: () => NOW,
        getEnv: (key) => (key === "PENUMBRA_GATE_QUALITY_PRESSURE_GUARD" ? "true" : undefined),
        checkPressure: () => false,
      },
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();

    expect(existsSync(join(dir, "gate-quality-digest-2026-06-13.md"))).toBe(true);
  });

  it("startGateQualityDigestSweeper: always runs when pressure guard flag is off, even if checkPressure returns true", async () => {
    const { startGateQualityDigestSweeper } =
      await import("../../src/sweepers/gate-quality-digest.js");

    const stop = startGateQualityDigestSweeper(
      {
        services,
        outDir: dir,
        now: () => NOW,
        checkPressure: () => true,
      },
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();

    expect(existsSync(join(dir, "gate-quality-digest-2026-06-13.md"))).toBe(true);
  });

  function countGateQualityDigestMemories(): number {
    return db
      .query<
        { n: number },
        []
      >(`SELECT COUNT(*) AS n FROM t2_memories WHERE hook = 'gate-quality-digest'`)
      .get()!.n;
  }
});
