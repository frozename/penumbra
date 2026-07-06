import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setPrincipalForTest } from "../../src/auth.js";
import { plansRegisterRoute } from "../../src/routes/plans.js";
import { createDaemonFetchHandler } from "../../src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* ignored: best-effort darwin sqlite hint */
}

const noop = (): void => undefined;

interface TestAgentchatAgent {
  name: string;
  tags?: string[];
  tier?: string;
  cost_cents_per_run?: number;
}
interface TestAgentchatConfig {
  agents: TestAgentchatAgent[];
}
function setAgentchatConfig(services: Services, config: TestAgentchatConfig): void {
  // Test fixtures inject agent shapes (tags, tier) outside the strict daemon
  // agentchatConfig schema. Object.assign widens at runtime without changing
  // the static Services type at call sites.
  Object.assign(services, { agentchatConfig: config });
}

interface PlanRow {
  plan_id: string;
  home_project: string;
  status: string;
}
interface PlanTaskRow {
  task_meta_id: string;
  task_id_in_board: string | null;
  status: string;
}

function startTestDaemon(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  taskWriter: TaskWriter;
  root: string;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), "plans-route-"));
  const worktreeRootDir = join(root, "worktrees");
  const mainRepoDir = join(root, "main");
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });

  const projectRegistry = new ProjectRegistry(
    new Map([
      ["penumbra", { project_id: "penumbra", root_path: root }],
      ["other", { project_id: "other", root_path: root }],
    ]),
  );

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-05T12:00:00.000Z"),
    worktreeRootDir,
    mainRepoDir,
    projectRegistry,
  });
  services.watchdog = {
    recordHeartbeat: noop,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };

  setAgentchatConfig(services, {
    agents: [
      { name: "claude-acp-sonnet", tags: ["typescript"], tier: "cli", cost_cents_per_run: 50 },
      { name: "codex-acp-fast", tags: ["typescript"], tier: "cli", cost_cents_per_run: 30 },
    ],
  });

  const taskEvents = new TaskEventBus();
  const taskWriter = new TaskWriter(db, {
    now: (): number => services.clock().getTime(),
    bus: taskEvents,
  });

  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token, taskEvents, taskWriter });

  return {
    fetch: (path: string, init?: RequestInit): Promise<Response> =>
      handler(new Request(`http://x${path}`, init)),
    services,
    token,
    taskWriter,
    root,
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

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function fixturePlan(
  opts: { home_project?: string; tasks?: { id: string; project?: string }[] } = {},
): string {
  const home = opts.home_project ?? "penumbra";
  const tasks = opts.tasks ?? [{ id: "1.1" }, { id: "1.2" }];
  const header = `---\nplan_id: ignored-by-server\nhome_project: ${home}\n---\n\n# Plan\n\n`;
  const taskBlocks = tasks
    .map((t) => {
      const projectLine = t.project ? `project: ${t.project}\n` : "";
      return [
        "```yaml meta",
        `id: '${t.id}'`,
        "files:",
        `  - notes/${t.id}.md`,
        "file_scope: new",
        projectLine.trimEnd(),
        "depends_on: []",
        "parallel_with: []",
        "preferred_agent: claude-acp-sonnet",
        "fallback_agent: codex-acp-fast",
        "task_size: small",
        "risk_class: paste-ready",
        "```",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  return header + taskBlocks + "\n";
}

function writePlanFile(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body, "utf8");
  return path;
}

test("POST /plans registers a plan and GET /plans/:plan_id returns plan + tasks", async () => {
  const daemon = startTestDaemon();
  try {
    const planPath = writePlanFile(daemon.root, "plan-a.md", fixturePlan());

    const create = await daemon.fetch("/plans", {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({ file_path: planPath }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { plan_id: string; status: string };
    expect(created.status).toBe("running");
    expect(created.plan_id).toMatch(/^[0-9a-f]{12}-\d+$/);

    const get = await daemon.fetch(`/plans/${created.plan_id}`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { plan: PlanRow; tasks: PlanTaskRow[] };
    expect(body.plan.plan_id).toBe(created.plan_id);
    expect(body.plan.home_project).toBe("penumbra");
    expect(body.plan.status).toBe("running");
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0]?.status).toBe("pending");
    expect(body.tasks[0]?.task_id_in_board).toBeNull();
  } finally {
    daemon.stop();
  }
});

test("GET /plans filters by status", async () => {
  const daemon = startTestDaemon();
  try {
    const p1 = writePlanFile(daemon.root, "plan-1.md", fixturePlan({ tasks: [{ id: "1.1" }] }));
    const p2 = writePlanFile(daemon.root, "plan-2.md", fixturePlan({ tasks: [{ id: "2.1" }] }));

    for (const p of [p1, p2]) {
      const res = await daemon.fetch("/plans", {
        method: "POST",
        headers: authJsonHeaders(daemon.token),
        body: JSON.stringify({ file_path: p }),
      });
      expect(res.status).toBe(201);
    }

    const all = await daemon.fetch("/plans", { headers: authHeaders(daemon.token) });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { plans: { plan_id: string }[] };
    expect(allBody.plans).toHaveLength(2);

    const running = await daemon.fetch("/plans?status=running", {
      headers: authHeaders(daemon.token),
    });
    expect(running.status).toBe(200);
    const runningBody = (await running.json()) as { plans: PlanRow[] };
    expect(runningBody.plans).toHaveLength(2);

    const completed = await daemon.fetch("/plans?status=completed", {
      headers: authHeaders(daemon.token),
    });
    expect(completed.status).toBe(200);
    const completedBody = (await completed.json()) as { plans: PlanRow[] };
    expect(completedBody.plans).toHaveLength(0);

    const bogus = await daemon.fetch("/plans?status=does-not-exist", {
      headers: authHeaders(daemon.token),
    });
    expect(bogus.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

test("GET /plans/:plan_id hydrates bound task_id_in_board + status=running", async () => {
  const daemon = startTestDaemon();
  try {
    const planPath = writePlanFile(
      daemon.root,
      "plan-bind.md",
      fixturePlan({ tasks: [{ id: "1.1" }, { id: "1.2" }] }),
    );
    const create = await daemon.fetch("/plans", {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({ file_path: planPath }),
    });
    expect(create.status).toBe(201);
    const { plan_id } = (await create.json()) as { plan_id: string };

    daemon.services.planWriter.bindTaskToBoard(plan_id, "1.1", "task-board-aaa");

    const get = await daemon.fetch(`/plans/${plan_id}`, { headers: authHeaders(daemon.token) });
    const body = (await get.json()) as { tasks: PlanTaskRow[] };
    const bound = body.tasks.find((t) => t.task_meta_id === "1.1");
    expect(bound?.task_id_in_board).toBe("task-board-aaa");
    expect(bound?.status).toBe("running");
    const unbound = body.tasks.find((t) => t.task_meta_id === "1.2");
    expect(unbound?.task_id_in_board).toBeNull();
    expect(unbound?.status).toBe("pending");
  } finally {
    daemon.stop();
  }
});

test("POST /plans/:plan_id/cancel flips plan status and cancels running children", async () => {
  const daemon = startTestDaemon();
  try {
    const planPath = writePlanFile(
      daemon.root,
      "plan-cancel.md",
      fixturePlan({ tasks: [{ id: "1.1" }, { id: "1.2" }] }),
    );
    const create = await daemon.fetch("/plans", {
      method: "POST",
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({ file_path: planPath }),
    });
    expect(create.status).toBe(201);
    const { plan_id } = (await create.json()) as { plan_id: string };

    const filed = daemon.taskWriter.file({
      prompt: "simulated child task",
      created_by_kind: "workflow",
      created_by_id: "plan-runtime",
    });

    daemon.services.planWriter.bindTaskToBoard(plan_id, "1.1", filed.task_id);

    const cancel = await daemon.fetch(`/plans/${plan_id}/cancel`, {
      method: "POST",
      headers: authHeaders(daemon.token),
    });
    expect(cancel.status).toBe(200);
    const cancelBody = (await cancel.json()) as {
      plan_id: string;
      status: string;
      cancelled_running_count: number;
    };
    expect(cancelBody.status).toBe("cancelled");
    expect(cancelBody.cancelled_running_count).toBe(1);

    const after = daemon.services.planWriter.getPlan(plan_id);
    expect(after?.status).toBe("cancelled");

    const childTask = daemon.taskWriter.get(filed.task_id);
    expect(childTask.status).toBe("cancelled");

    const ghost = await daemon.fetch("/plans/no-such-plan/cancel", {
      method: "POST",
      headers: authHeaders(daemon.token),
    });
    expect(ghost.status).toBe(404);
  } finally {
    daemon.stop();
  }
});

function makeRegisterRequest(filePath: string): Request {
  return new Request("http://x/plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_path: filePath }),
  });
}

test("POST /plans rejects worker-token principals with 403 (no readFile of arbitrary paths)", async () => {
  const daemon = startTestDaemon();
  try {
    const legitPlan = writePlanFile(daemon.root, "plan-worker.md", fixturePlan());

    // A worker principal must be rejected pre-readFile regardless of the file
    // path — this closes the existence oracle where a worker could distinguish
    // /etc/hosts (readable) from a bogus path (ENOENT) via the response.
    const workerLegit = makeRegisterRequest(legitPlan);
    setPrincipalForTest(workerLegit, {
      kind: "worker",
      worker_id: "w-1",
      token_hash: "hash-1",
    });
    const legitRes = await plansRegisterRoute(workerLegit, daemon.services);
    expect(legitRes.status).toBe(403);

    const workerHosts = makeRegisterRequest("/etc/hosts");
    setPrincipalForTest(workerHosts, {
      kind: "worker",
      worker_id: "w-1",
      token_hash: "hash-1",
    });
    const hostsRes = await plansRegisterRoute(workerHosts, daemon.services);
    expect(hostsRes.status).toBe(403);

    const workerMissing = makeRegisterRequest(join(daemon.root, "does-not-exist.md"));
    setPrincipalForTest(workerMissing, {
      kind: "worker",
      worker_id: "w-1",
      token_hash: "hash-1",
    });
    const missingRes = await plansRegisterRoute(workerMissing, daemon.services);
    expect(missingRes.status).toBe(403);

    // No principal (no auth applied) is also rejected.
    const anon = makeRegisterRequest(legitPlan);
    const anonRes = await plansRegisterRoute(anon, daemon.services);
    expect(anonRes.status).toBe(403);
  } finally {
    daemon.stop();
  }
});

test("POST /plans rejects non-regular files (directory) with 400 pre-readFile", async () => {
  const daemon = startTestDaemon();
  try {
    const dirPath = join(daemon.root, "a-directory");
    mkdirSync(dirPath, { recursive: true });

    const req = makeRegisterRequest(dirPath);
    setPrincipalForTest(req, { kind: "shared", via: "config" });
    const res = await plansRegisterRoute(req, daemon.services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("invalid_plan_file");
    expect(body.reason).toBe("not_a_regular_file");
  } finally {
    daemon.stop();
  }
});

test("POST /plans rejects oversize files with 400 pre-readFile (no OOM)", async () => {
  const daemon = startTestDaemon();
  try {
    // Craft a plan file whose declared size exceeds the cap. The route must
    // reject after stat() and MUST NOT call readFile() on it.
    const bigPath = join(daemon.root, "huge-plan.md");
    // Use a 12 MiB file (> 10 MiB cap); write it as a real file so stat.size
    // reflects reality without relying on sparse-file quirks.
    const twelveMiB = 12 * 1024 * 1024;
    writeFileSync(bigPath, Buffer.alloc(twelveMiB, 0x61));

    const req = makeRegisterRequest(bigPath);
    setPrincipalForTest(req, { kind: "shared", via: "config" });
    const res = await plansRegisterRoute(req, daemon.services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      reason?: string;
      size?: number;
      max_bytes?: number;
    };
    expect(body.error).toBe("invalid_plan_file");
    expect(body.reason).toBe("file_too_large");
    expect(body.size).toBe(twelveMiB);
    expect(typeof body.max_bytes).toBe("number");
  } finally {
    daemon.stop();
  }
});

test("POST /plans still succeeds for shared principal on a normal plan file", async () => {
  const daemon = startTestDaemon();
  try {
    const planPath = writePlanFile(daemon.root, "plan-shared-ok.md", fixturePlan());

    // Route level (bypasses fetch handler auth): stamp shared principal.
    const req = makeRegisterRequest(planPath);
    setPrincipalForTest(req, { kind: "shared", via: "config" });
    const res = await plansRegisterRoute(req, daemon.services);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { plan_id: string; status: string };
    expect(body.status).toBe("running");
  } finally {
    daemon.stop();
  }
});
