import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { TaskWriter } from "../../src/tasks/writer.js";
import { pickPreferred } from "../../src/tasks/auction.js";
import { pickPreferred as exportedPickPreferred } from "../../src/index.js";
import type { FileTaskInput } from "../../src/tasks/schema.js";
import type { AgentDescriptor } from "../../src/tasks/eligibility.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function freshDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-auction-race-"));
  const dbPath = join(dir, "race.sqlite");
  const db = new Database(dbPath);
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.close();
  return dbPath;
}
const WRITER_URL = new URL("../../src/tasks/writer.js", import.meta.url).href;

function baseInput(overrides: Partial<FileTaskInput> = {}): FileTaskInput {
  return {
    prompt: "implement auction behavior",
    created_by_kind: "human",
    created_by_id: "cli",
    ...overrides,
  };
}

type AgentRegistry = Map<string, AgentDescriptor>;

function defaultAgents(): AgentRegistry {
  return new Map<string, AgentDescriptor>([
    ["A", { name: "A", tags: ["core"], tier: "oc", cost_cents_per_run: 25 }],
    ["B", { name: "B", tags: ["core"], tier: "oc", cost_cents_per_run: 25 }],
    ["C", { name: "C", tags: ["core"], tier: "premium", cost_cents_per_run: 50 }],
  ]);
}

describe("TaskWriter.next auction window", () => {
  let db: Database;
  let nowMs: number;
  let agents: AgentRegistry;

  beforeEach(() => {
    db = freshDb();
    nowMs = 0;
    agents = defaultAgents();
  });

  function makeWriter(rankings: Array<{ agent_name: string; score: number }>) {
    return new TaskWriter(db, {
      now: () => nowMs,
      resolveAgent: (name) => agents.get(name),
      routeAgent: () => ({
        detail: "rank" as const,
        candidates: {
          task_type: "implement_substantial",
          window: { from: null, to: "" },
          candidates: rankings.map((r) => ({
            agent_name: r.agent_name,
            samples: 1,
            successes: 1,
            failures: 0,
            neutral: 0,
            success_rate: 1,
            avg_rounds: null,
            avg_latency_ms: null,
            cost_per_success_usd: null,
            avg_reviewer_findings: null,
            avg_trust_score: null,
            score: r.score,
            last_outcome_at: "",
          })),
        },
      }),
    });
  }

  test("inside window non-preferred agent is blocked; preferred agent leases", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 10_000;
    const bResult = await writer.next({ agent_id: "B" });
    expect(bResult).toBeNull();

    const aResult = await writer.next({ agent_id: "A" });
    expect(aResult).not.toBeNull();
    expect(aResult!.task_id).toBe(task_id);
    expect(aResult!.lease_id).toMatch(/^lease_[0-9a-f-]{36}$/);

    const afterLease = await writer.next({ agent_id: "B" });
    expect(afterLease).toBeNull();
  });

  test("after window expires, non-preferred eligible agent can lease FCFS", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 31_000;
    const leased = await writer.next({ agent_id: "B" });
    expect(leased).not.toBeNull();
    expect(leased!.task_id).toBe(task_id);
  });

  test("single eligible agent claims immediately", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    writer.file(
      baseInput({
        eligibility: { allow_agents: ["A"] },
      }),
    );

    nowMs = 1_000;
    const leased = await writer.next({ agent_id: "A" });
    expect(leased).not.toBeNull();
    expect(leased!.task_id).toMatch(/^task_[0-9a-f-]{36}$/);
  });

  test("successful lease persists auction_score for the claiming agent", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 10_000;
    const leased = await writer.next({ agent_id: "A" });
    expect(leased).not.toBeNull();

    const row = db
      .query<
        { auction_score: number | null },
        [string]
      >(`SELECT auction_score FROM task_leases WHERE task_id = ? LIMIT 1`)
      .get(task_id);

    expect(row).not.toBeNull();
    expect(row!.auction_score).toBe(90);
  });

  test("preference_window_ms: 0 disables preferred hold and allows immediate FCFS", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(
      baseInput({
        eligibility: { preference_window_ms: 0 },
      }),
    );

    nowMs = 0;
    const leased = await writer.next({ agent_id: "B" });
    expect(leased).not.toBeNull();
    expect(leased!.task_id).toBe(task_id);
  });

  test("auctioned event is written at most once per task across repeated next calls", async () => {
    const writer = makeWriter([
      { agent_name: "A", score: 90 },
      { agent_name: "B", score: 30 },
    ]);
    const { task_id } = writer.file(baseInput());

    nowMs = 5_000;
    expect(await writer.next({ agent_id: "B" })).toBeNull();
    expect(await writer.next({ agent_id: "B" })).toBeNull();
    expect(await writer.next({ agent_id: "B" })).toBeNull();

    const rows = db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'auctioned'`)
      .get(task_id);
    expect(rows).not.toBeNull();
    expect(rows!.n).toBe(1);
  });

  test("50 concurrent next() calls: exactly one lease is created", async () => {
    const dbPath = freshDbFile();
    const dbDir = dbPath.slice(0, dbPath.lastIndexOf("/"));
    const workerScript = join(tmpdir(), `penumbra-auction-race-${crypto.randomUUID()}.mjs`);
    const startAt = Date.now() + 500;
    const { task_id } = (() => {
      const writer = new TaskWriter(new Database(dbPath), {
        now: () => 10_000,
        resolveAgent: (name) => agents.get(name),
        routeAgent: () => ({
          detail: "rank" as const,
          candidates: {
            task_type: "implement_substantial",
            window: { from: null, to: "" },
            candidates: [
              {
                agent_name: "A",
                samples: 1,
                successes: 1,
                failures: 0,
                neutral: 0,
                success_rate: 1,
                avg_rounds: null,
                avg_latency_ms: null,
                cost_per_success_usd: null,
                avg_reviewer_findings: null,
                avg_trust_score: null,
                score: 90,
                last_outcome_at: "",
              },
              {
                agent_name: "B",
                samples: 1,
                successes: 1,
                failures: 0,
                neutral: 0,
                success_rate: 1,
                avg_rounds: null,
                avg_latency_ms: null,
                cost_per_success_usd: null,
                avg_reviewer_findings: null,
                avg_trust_score: null,
                score: 30,
                last_outcome_at: "",
              },
            ],
          },
        }),
      });
      const created = writer.file(baseInput());
      return created;
    })();

    writeFileSync(
      workerScript,
      `import { Database } from "bun:sqlite";
import { TaskWriter } from ${JSON.stringify(WRITER_URL)};

try {
  const dbPath = process.argv[2];
  const startAt = Number(process.argv[3]);
  const taskId = process.argv[4];
  const agentId = process.argv[5];
  const db = new Database(dbPath);
  const writer = new TaskWriter(db, {
    now: () => 10_000,
    resolveAgent: (name) => new Map([
      ["A", { name: "A", tags: ["core"], tier: "oc", cost_cents_per_run: 25 }],
      ["B", { name: "B", tags: ["core"], tier: "oc", cost_cents_per_run: 25 }],
    ]).get(name),
    routeAgent: () => ({
      detail: "rank",
      candidates: {
        task_type: "implement_substantial",
        window: { from: null, to: "" },
        candidates: [
          {
            agent_name: "A",
            samples: 1,
            successes: 1,
            failures: 0,
            neutral: 0,
            success_rate: 1,
            avg_rounds: null,
            avg_latency_ms: null,
            cost_per_success_usd: null,
            avg_reviewer_findings: null,
            avg_trust_score: null,
            score: 90,
            last_outcome_at: "",
          },
          {
            agent_name: "B",
            samples: 1,
            successes: 1,
            failures: 0,
            neutral: 0,
            success_rate: 1,
            avg_rounds: null,
            avg_latency_ms: null,
            cost_per_success_usd: null,
            avg_reviewer_findings: null,
            avg_trust_score: null,
            score: 30,
            last_outcome_at: "",
          },
        ],
      },
    }),
  });
  while (Date.now() < startAt) {}
  const result = await writer.next({ agent_id: agentId });
  console.log(JSON.stringify(result));
  db.close();
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
}
`,
    );

    const attempts = Array.from(
      { length: 50 },
      (_, i) =>
        new Promise<string | null>((resolve, reject) => {
          const child = spawn(process.execPath, [
            workerScript,
            dbPath,
            String(startAt),
            task_id,
            i % 2 === 0 ? "A" : "B",
          ]);
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
          child.on("exit", (code) => {
            if (code === 0) resolve(stdout.trim() === "null" ? null : JSON.parse(stdout.trim()));
            else reject(stderr || `worker exited ${code}`);
          });
        }),
    );

    try {
      const results = await Promise.allSettled(attempts);
      const fulfilled = results
        .filter((r): r is PromiseFulfilledResult<string | null> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((value): value is string => value !== null);

      expect(fulfilled).toHaveLength(1);

      const verificationDb = new Database(dbPath);
      const openLeases = verificationDb
        .query<
          { n: number },
          [string]
        >(`SELECT COUNT(*) AS n FROM task_leases WHERE task_id = ? AND released_at IS NULL`)
        .get(task_id);
      verificationDb.close();
      expect(openLeases!.n).toBe(1);
    } finally {
      rmSync(workerScript, { force: true });
      rmSync(dbPath, { force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe("pickPreferred", () => {
  test("uses latency as a tiebreak before name", () => {
    const out = pickPreferred(
      [
        { agent_name: "zulu-slow", score: 10, avg_latency_ms: 5000 },
        { agent_name: "aardvark-fast", score: 10, avg_latency_ms: 1000 },
      ],
      [
        { name: "zulu-slow", tags: ["core"], tier: "oc", cost_cents_per_run: 25 },
        { name: "aardvark-fast", tags: ["core"], tier: "oc", cost_cents_per_run: 25 },
      ],
    );

    expect(out).toEqual({ agent_id: "aardvark-fast", score: 10 });
  });
});

describe("pickPreferred public export", () => {
  test("selects the highest-scored eligible agent from the package root", () => {
    const out = exportedPickPreferred(
      [
        { agent_name: "a", score: 0.9 },
        { agent_name: "b", score: 0.4 },
      ],
      [
        { name: "a", tags: ["core"], tier: "oc", cost_cents_per_run: 25 },
        { name: "b", tags: ["core"], tier: "oc", cost_cents_per_run: 25 },
      ],
    );

    expect(out).toEqual({ agent_id: "a", score: 0.9 });
  });
});
