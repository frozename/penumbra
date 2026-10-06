import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type RecallRequest,
  type RecallResult,
  type Services,
  type Watchdog,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";

import { chainsStartRoute } from "@src/routes/chains.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

// strict-mode env can leak from a live maestro shell; clear it here so test fixtures stay deterministic
beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

interface HandoffRow {
  message: string;
}
interface LaneRow {
  gate_status: string;
  ts_opened: string;
  ts_closed: string | null;
  override_reason: string | null;
  recalled_memory_ids: string;
}
interface RecalledMemory {
  id: string;
  title: string;
  obs_type: string;
  snippet_head?: string;
}
interface ChainsStartBody {
  lane_id?: string;
  recalled_memory_ids?: string[];
  recalled_memories?: RecalledMemory[];
  handoff_id: string;
}

const STABLE_TS = "2026-04-26T00:00:00Z";

function fakeRecallHit(id: string, title: string): RecallResult {
  return {
    id,
    tier: "t2",
    score: 1,
    fusedScore: 1,
    sources: ["t2"],
    title,
    body: "",
    project_id: null,
    source_session_ids: [],
    created_at: STABLE_TS,
    ts: STABLE_TS,
  };
}

const testWatchdog: Watchdog = {
  recordHeartbeat: () => undefined,
  hasActiveWorker: () => true,
  getStaleWorkers: () => [],
  getStaleHeartbeatAges: () => [],
  tick: () => Promise.resolve(),
};

function tempServices(withProjectRegistry = false): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/chains-auto-recall-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(STABLE_TS),
    uuid: (() => {
      let n = 0;
      return (): string => `id-${String(++n)}`;
    })(),
    ...(withProjectRegistry
      ? {
          projectRegistry: new ProjectRegistry(
            new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
          ),
        }
      : {}),
  });
  services.watchdog = testWatchdog;
  return services;
}

function getHandoff(services: Services, handoff_id: string): HandoffRow {
  const row = services.db
    .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
    .get(handoff_id);
  if (!row) throw new Error(`handoff not found: ${handoff_id}`);
  return row;
}

function getLane(services: Services, lane_id: string): LaneRow {
  const row = services.db
    .query<LaneRow, [string]>(`SELECT * FROM lane_ledger WHERE lane_id=?`)
    .get(lane_id);
  if (!row) throw new Error(`lane not found: ${lane_id}`);
  return row;
}

function insertProjectBrief(services: Services, projectId: string, briefMd: string): void {
  services.db.run(
    "INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run) VALUES('cycle-brief', 1, 'manual', 0, 'complete', '[]')",
  );
  services.db
    .prepare(
      `INSERT INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle)
       VALUES(?, ?, '[]', 2, 'cycle-brief')`,
    )
    .run(projectId, briefMd);
}

async function readBody(res: Response): Promise<ChainsStartBody> {
  return (await res.json()) as ChainsStartBody;
}

function parseStringArray(json: string): string[] {
  return JSON.parse(json) as string[];
}

test("POST /chains/start auto-recalls STANDARD context and opens a lane", async () => {
  const services = tempServices(true);
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> =>
    Promise.resolve([
      fakeRecallHit("m1", "memo1"),
      fakeRecallHit("m2", "memo2"),
      fakeRecallHit("m3", "memo3"),
    ]);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "do the thing",
        task_class: "STANDARD",
        project_id: "penumbra",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readBody(res);
  expect(body.lane_id).toBeTruthy();
  expect(body.recalled_memory_ids).toEqual(["m1", "m2", "m3"]);
  expect(body.recalled_memories).toEqual([
    { id: "m1", title: "memo1", obs_type: "t2", snippet_head: "" },
    { id: "m2", title: "memo2", obs_type: "t2", snippet_head: "" },
    { id: "m3", title: "memo3", obs_type: "t2", snippet_head: "" },
  ]);

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message.startsWith("## Relevant prior context")).toBe(true);

  if (!body.lane_id) throw new Error("expected lane_id");
  const lane = getLane(services, body.lane_id);
  expect(lane.gate_status).toBe("open");
  expect(parseStringArray(lane.recalled_memory_ids)).toEqual(["m1", "m2", "m3"]);
});

test("POST /chains/start prepends project brief when auto-recall project brief flag is enabled", async () => {
  const services = tempServices(true);
  insertProjectBrief(
    services,
    "penumbra",
    "# Project Brief: penumbra\n\nCurrent architectural brief.",
  );
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> =>
    Promise.resolve([fakeRecallHit("m1", "memo1")]);
  const previous = process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF;
  process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF = "true";

  try {
    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify({
          initial_agent: "planner",
          message: "do the thing",
          task_class: "STANDARD",
          project_id: "penumbra",
        }),
      }),
      services,
    );

    expect(res.status).toBe(200);
    const body = await readBody(res);
    const handoff = getHandoff(services, body.handoff_id);
    expect(handoff.message).toStartWith(
      "## Project brief\n\n# Project Brief: penumbra\n\nCurrent architectural brief.",
    );
    expect(handoff.message.indexOf("## Project brief")).toBeLessThan(
      handoff.message.indexOf("## Relevant prior context"),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF;
    } else {
      process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF = previous;
    }
  }
});

test("POST /chains/start does not inject project brief when project brief flag is disabled", async () => {
  const services = tempServices(true);
  insertProjectBrief(
    services,
    "penumbra",
    "# Project Brief: penumbra\n\nCurrent architectural brief.",
  );
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> =>
    Promise.resolve([fakeRecallHit("m1", "memo1")]);
  const previous = process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF;
  delete process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF;

  try {
    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify({
          initial_agent: "planner",
          message: "do the thing",
          task_class: "STANDARD",
          project_id: "penumbra",
        }),
      }),
      services,
    );

    expect(res.status).toBe(200);
    const body = await readBody(res);
    const handoff = getHandoff(services, body.handoff_id);
    expect(handoff.message).not.toContain("## Project brief");
    expect(handoff.message).toContain("## Relevant prior context");
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF;
    } else {
      process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF = previous;
    }
  }
});

test("POST /chains/start does not inject project brief when no brief exists", async () => {
  const services = tempServices(true);
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> =>
    Promise.resolve([fakeRecallHit("m1", "memo1")]);
  const previous = process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF;
  process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF = "true";

  try {
    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify({
          initial_agent: "planner",
          message: "do the thing",
          task_class: "STANDARD",
          project_id: "penumbra",
        }),
      }),
      services,
    );

    expect(res.status).toBe(200);
    const body = await readBody(res);
    const handoff = getHandoff(services, body.handoff_id);
    expect(handoff.message).not.toContain("## Project brief");
    expect(handoff.message).toContain("## Relevant prior context");
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF;
    } else {
      process.env.PENUMBRA_AUTO_RECALL_PROJECT_BRIEF = previous;
    }
  }
});

test("POST /chains/start with TRIVIAL opens a lane and calls recall with top_k=3", async () => {
  const services = tempServices();
  const recallArgs: RecallRequest[] = [];
  services.recallReader.recall = (args: RecallRequest): Promise<RecallResult[]> => {
    recallArgs.push(args);
    return Promise.resolve([fakeRecallHit("tm1", "trivial-memo")]);
  };

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "trivial work",
        task_class: "TRIVIAL",
        project_id: "penumbra",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readBody(res);
  expect(body.lane_id).toBeTruthy();
  expect(body.recalled_memory_ids).toEqual(["tm1"]);
  expect(body.recalled_memories).toEqual([
    { id: "tm1", title: "trivial-memo", obs_type: "t2", snippet_head: "" },
  ]);
  expect(recallArgs).toHaveLength(1);
  expect(recallArgs[0]?.limit).toBe(3);

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).toContain("## Relevant prior context");

  if (!body.lane_id) throw new Error("expected lane_id");
  const lane = getLane(services, body.lane_id);
  expect(parseStringArray(lane.recalled_memory_ids)).toEqual(["tm1"]);
});

test("POST /chains/start workflow-internal read-only dispatch records a born-closed skipped lane", async () => {
  const services = tempServices();
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> =>
    Promise.resolve([fakeRecallHit("wf-m1", "wf-memo")]);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "persona review dispatch",
        task_class: "TRIVIAL",
        dispatch_kind: "workflow",
        workflow_run_id: "wf-1",
        use_worktree: false,
        project_id: "penumbra",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readBody(res);
  expect(body.lane_id).toBeTruthy();
  expect(body.recalled_memory_ids).toEqual(["wf-m1"]);

  if (!body.lane_id) throw new Error("expected lane_id");
  const lane = getLane(services, body.lane_id);
  expect(lane.gate_status).toBe("skipped");
  expect(lane.ts_closed).not.toBeNull();
  expect(lane.ts_closed).toBe(lane.ts_opened);
  expect(lane.override_reason).toBe(
    "TRIVIAL workflow-internal dispatch with no worktree: nothing to land, no gate",
  );
  expect(parseStringArray(lane.recalled_memory_ids)).toEqual(["wf-m1"]);
});

test("POST /chains/start STANDARD workflow dispatch with use_worktree false opens an open lane", async () => {
  const services = tempServices();
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> =>
    Promise.resolve([fakeRecallHit("wf-m3", "wf-memo-3")]);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "workflow no-worktree dispatch with tools",
        task_class: "STANDARD",
        dispatch_kind: "workflow",
        workflow_run_id: "wf-3",
        use_worktree: false,
        project_id: "penumbra",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readBody(res);
  expect(body.lane_id).toBeTruthy();

  if (!body.lane_id) throw new Error("expected lane_id");
  const lane = getLane(services, body.lane_id);
  expect(lane.gate_status).toBe("open");
  expect(lane.ts_closed).toBeNull();
  expect(lane.override_reason).toBeNull();
});

test("POST /chains/start workflow dispatch with use_worktree true still opens an open lane", async () => {
  const services = tempServices();
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> =>
    Promise.resolve([fakeRecallHit("wf-m2", "wf-memo-2")]);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "workflow worktree dispatch",
        task_class: "TRIVIAL",
        dispatch_kind: "workflow",
        workflow_run_id: "wf-2",
        use_worktree: true,
        project_id: "penumbra",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readBody(res);
  expect(body.lane_id).toBeTruthy();

  if (!body.lane_id) throw new Error("expected lane_id");
  const lane = getLane(services, body.lane_id);
  expect(lane.gate_status).toBe("open");
  expect(lane.ts_closed).toBeNull();
  expect(lane.override_reason).toBeNull();
});

test("POST /chains/start proceeds when auto recall throws", async () => {
  const services = tempServices(true);
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> =>
    Promise.reject(new Error("sirius down"));

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "do the thing",
        task_class: "BOUNDARY",
        project_id: "penumbra",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readBody(res);
  expect(body.lane_id).toBeTruthy();

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).not.toContain("## Relevant prior context");

  if (!body.lane_id) throw new Error("expected lane_id");
  const lane = getLane(services, body.lane_id);
  expect(parseStringArray(lane.recalled_memory_ids)).toEqual([]);
});

test("POST /chains/start respects PENUMBRA_AUTO_RECALL_ENABLED=false", async () => {
  const services = tempServices(true);
  const previous = process.env.PENUMBRA_AUTO_RECALL_ENABLED;
  process.env.PENUMBRA_AUTO_RECALL_ENABLED = "false";
  let called = false;
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> => {
    called = true;
    return Promise.reject(new Error("recall should not run when disabled"));
  };

  try {
    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify({
          initial_agent: "planner",
          message: "do the thing",
          task_class: "STANDARD",
          project_id: "penumbra",
        }),
      }),
      services,
    );

    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.lane_id).toBeTruthy();
    expect(called).toBe(false);

    const handoff = getHandoff(services, body.handoff_id);
    expect(handoff.message).not.toContain("## Relevant prior context");

    if (!body.lane_id) throw new Error("expected lane_id");
    const lane = getLane(services, body.lane_id);
    expect(parseStringArray(lane.recalled_memory_ids)).toEqual([]);
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_AUTO_RECALL_ENABLED;
    } else {
      process.env.PENUMBRA_AUTO_RECALL_ENABLED = previous;
    }
  }
});

test("POST /chains/start times out auto recall after 1500ms and opens a lane without injection", async () => {
  const services = tempServices(true);
  services.recallReader.recall = async (_req: RecallRequest): Promise<RecallResult[]> => {
    await new Promise((resolve) => setTimeout(resolve, 1700));
    return [];
  };

  const started = Date.now();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "do the thing",
        task_class: "STANDARD",
        project_id: "penumbra",
      }),
    }),
    services,
  );
  const elapsed = Date.now() - started;

  expect(res.status).toBe(200);
  expect(elapsed).toBeLessThan(1800);
  const body = await readBody(res);
  expect(body.recalled_memory_ids).toEqual([]);
  expect(body.recalled_memories).toEqual([]);

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).not.toContain("## Relevant prior context");

  if (!body.lane_id) throw new Error("expected lane_id");
  const lane = getLane(services, body.lane_id);
  expect(lane.gate_status).toBe("open");
  expect(parseStringArray(lane.recalled_memory_ids)).toEqual([]);
});

test("POST /chains/start skips auto recall when project_id is absent", async () => {
  const services = tempServices(true);
  let called = false;
  services.recallReader.recall = (_req: RecallRequest): Promise<RecallResult[]> => {
    called = true;
    return Promise.reject(new Error("recall should not be called without project_id"));
  };

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "do the thing",
        task_class: "STANDARD",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  expect(called).toBe(false);
  const body = await readBody(res);
  expect(body.recalled_memory_ids).toEqual([]);
  expect(body.recalled_memories).toEqual([]);

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).not.toContain("## Relevant prior context");

  if (!body.lane_id) throw new Error("expected lane_id");
  const lane = getLane(services, body.lane_id);
  expect(lane.gate_status).toBe("open");
  expect(parseStringArray(lane.recalled_memory_ids)).toEqual([]);
});

test("POST /chains/start in legacy mode does not create a lane row", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "do the thing" }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = await readBody(res);
  expect(body.lane_id).toBeUndefined();
  expect(body.recalled_memory_ids).toBeUndefined();
  expect(body.recalled_memories).toBeUndefined();

  const handoff = getHandoff(services, body.handoff_id);
  expect(handoff.message).not.toContain("## Relevant prior context");

  const lane = services.db.query<LaneRow, []>(`SELECT * FROM lane_ledger`).get();
  expect(lane).toBeNull();
});
