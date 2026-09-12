import { TaskRouterConfigSchema } from "@penumbra/config";
import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
  type Watchdog,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workflowsRunRoute } from "@src/routes/workflows.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

const RAW_DISPATCH_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'native-dispatch-context',
  description: 'dispatches through the raw daemon workflow context',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async (ctx) => {
  const rawCtx = ctx as { chainStart: (input: unknown) => Promise<Response> | Response };
  const count = typeof ctx.args.count === 'number' ? ctx.args.count : 1;
  const delayMs = typeof ctx.args.delay_ms === 'number' ? ctx.args.delay_ms : 0;
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const response = await rawCtx.chainStart({
      initial_agent: typeof ctx.args.initial_agent === 'string' ? ctx.args.initial_agent : 'codex',
      message: typeof ctx.args.message === 'string' ? ctx.args.message : 'native child dispatch',
      task_name: \`native-binding-\${String(i + 1)}\`,
      branch_type: 'feature',
      project_id: typeof ctx.args.project_id === 'string' ? ctx.args.project_id : ctx.project,
      task_type: 'implement_small',
      task_class: 'TRIVIAL',
      branch_base: 'release/base',
      trust_mode: 'all',
      max_hops: 3,
      use_worktree: true,
      isolated_install: false,
      tool_free: true,
      dispatch_kind: 'workflow',
      workflow_run_id: 'wfrun-foreign',
    });
    results.push({ status: response.status, body: await response.json().catch(() => null) });
  }
  return { results };
};
`;

type HandoffRow = {
  handoff_id: string;
  to_agent: string;
  project_id: string | null;
  chain_trust_mode: string | null;
  chain_task_type: string | null;
  branch_base: string | null;
  branch_name: string | null;
  isolated_install: number | null;
  chain_max_hops: number | null;
  use_worktree: number | null;
  dispatch_kind: string | null;
  workflow_run_id: string | null;
};

type Harness = {
  services: Services;
  db: Database;
  workflowRuns?: ReturnType<typeof createWorkflowRunsRegistry>;
};

async function setupHarness(
  root: string,
  opts: { withRunRegistry: boolean; foreignRunProject?: string; toolFreeRole?: boolean },
): Promise<Harness> {
  writeFileSync(join(root, ".penumbra-project"), "test-project\n");
  mkdirSync(join(root, "playbooks"), { recursive: true });
  mkdirSync(join(root, "workflows/native-dispatch-context"), { recursive: true });
  writeFileSync(join(root, "workflows/native-dispatch-context/workflow.ts"), RAW_DISPATCH_WORKFLOW);
  const registry = await buildRegistry({
    playbooksDir: join(root, "playbooks"),
    workflowsDir: join(root, "workflows"),
  });
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const foreignRoot = join(root, "foreign-project-root");
  mkdirSync(foreignRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry(
    new Map([
      ["test-project", { project_id: "test-project", root_path: root }],
      ["foreign-project", { project_id: "foreign-project", root_path: foreignRoot }],
    ]),
  );
  const runIds = opts.foreignRunProject ? ["wfrun-foreign", "wfrun-current"] : ["wfrun-current"];
  const workflowRuns = opts.withRunRegistry
    ? createWorkflowRunsRegistry({
        uuid: () => runIds.shift() ?? "wfrun-unexpected",
        clock: () => new Date("2026-09-12T12:00:00.000Z"),
        db,
        storageRoot: root,
      })
    : undefined;
  if (workflowRuns && opts.foreignRunProject) {
    expect(workflowRuns.register("foreign-workflow", opts.foreignRunProject)).toBe("wfrun-foreign");
  }
  let uuidCounter = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-09-12T12:00:00.000Z"),
    uuid: () => `native-${String(++uuidCounter)}`,
    agentRegistry: opts.toolFreeRole ? ["http-seat"] : ["codex"],
    agentRouting: opts.toolFreeRole
      ? {
          agents: [
            {
              name: "http-seat",
              roles: ["executor"],
              adapter: "openai-compat-http",
              pricing_mode: "subscription",
              subscription_provider: "openai",
            },
          ],
          default_roles: {},
          role_exploration_policy: "ranked-first",
        }
      : undefined,
    projectRegistry,
    workflowRegistry: registry,
    workflowRuns,
    worktreeRootDir: join(root, "worktrees"),
  });
  const watchdog: Watchdog = {
    recordHeartbeat: (): void => undefined,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  services.watchdog = watchdog;
  services.agentchatConfig = {
    agents: opts.toolFreeRole
      ? [{ name: "http-seat", adapter: "openai-compat-http", roles: ["executor"] }]
      : [{ name: "codex", adapter: "codex-cli", roles: [] }],
  };
  if (opts.toolFreeRole) {
    services.taskRouterConfig = TaskRouterConfigSchema.parse({ mode: "auto" });
    services.modelAliasMap = {};
  }
  return { services, db, workflowRuns };
}

async function runWorkflow(
  services: Services,
  root: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return await workflowsRunRoute(
    new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "native-dispatch-context",
        cwd: root,
        wait: true,
        args,
      }),
    }),
    services,
  );
}

function readHandoffs(db: Database): HandoffRow[] {
  return db
    .query<HandoffRow, []>(
      `SELECT handoff_id, to_agent, project_id, chain_trust_mode, chain_task_type,
              branch_base, branch_name, isolated_install, chain_max_hops,
              use_worktree, dispatch_kind, workflow_run_id
         FROM handoffs
        ORDER BY handoff_id`,
    )
    .all();
}

test("HTTP workflow raw dispatch binds the registered run and preserves chain input fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-native-dispatch-context-"));
  const { services, db, workflowRuns } = await setupHarness(root, {
    withRunRegistry: true,
    foreignRunProject: "test-project",
  });
  try {
    const response = await runWorkflow(services, root, { count: 2 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workflow_run_id?: string | null;
      outcome?: string;
      runResult?: { results?: { status: number }[] };
    };
    expect(body.outcome).toBe("success");
    expect(body.workflow_run_id).toBe("wfrun-current");
    expect(body.runResult?.results?.map((result) => result.status)).toEqual([200, 200]);
    expect(workflowRuns?.verify("wfrun-current")).toMatchObject({
      workflow_name: "native-dispatch-context",
      project_id: "test-project",
    });

    const rows = readHandoffs(db);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.project_id).toBe("test-project");
      expect(row.chain_trust_mode).toBe("all");
      expect(row.chain_task_type).toBe("implement_small");
      expect(row.branch_base).toBe("release/base");
      expect(row.branch_name?.startsWith("feature/native-binding-")).toBe(true);
      expect(row.isolated_install).toBe(0);
      expect(row.chain_max_hops).toBe(3);
      expect(row.use_worktree).toBe(1);
      expect(row.dispatch_kind).toBe("workflow");
      expect(row.workflow_run_id).toBe("wfrun-current");
    }

    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("expected two workflow handoffs");
    expect(
      services.handoffWriter.claimDispatch(first.handoff_id, "fake-worker", {
        workflow_run_id: "wfrun-current",
        maxWorkflowSiblingsPerWorker: 1,
      }),
    ).toBe(true);
    expect(
      services.handoffWriter.claimDispatch(second.handoff_id, "fake-worker", {
        workflow_run_id: "wfrun-current",
        maxWorkflowSiblingsPerWorker: 1,
      }),
    ).toBe(false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw dispatch cannot retain a supplied run token when no run was registered", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-native-dispatch-no-run-"));
  const { services, db } = await setupHarness(root, { withRunRegistry: false });
  try {
    const response = await runWorkflow(services, root, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workflow_run_id?: string | null; outcome?: string };
    expect(body.outcome).toBe("success");
    expect(body.workflow_run_id).toBeNull();
    const rows = readHandoffs(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dispatch_kind).toBe("workflow");
    expect(rows[0]?.workflow_run_id).toBeNull();
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw dispatch preserves tool_free through the real role-routing consumer", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-native-dispatch-tool-free-"));
  const { services, db } = await setupHarness(root, {
    withRunRegistry: true,
    toolFreeRole: true,
  });
  try {
    const response = await runWorkflow(services, root, { initial_agent: "executor" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome?: string;
      runResult?: { results?: { status: number; body?: { routed_agent?: string } }[] };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.results).toHaveLength(1);
    expect(body.runResult?.results?.[0]?.status).toBe(200);
    expect(body.runResult?.results?.[0]?.body?.routed_agent).toBe("http-seat");
    const rows = readHandoffs(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.to_agent).toBe("http-seat");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreign run identity cannot exempt a raw dispatch from project mismatch enforcement", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-native-dispatch-project-mismatch-"));
  const { services, db } = await setupHarness(root, {
    withRunRegistry: true,
    foreignRunProject: "foreign-project",
  });
  const prior = process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "1";
  try {
    const response = await runWorkflow(services, root, {
      project_id: "foreign-project",
      message: `inspect ${join(root, "current-project.ts")}`,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome?: string;
      runResult?: { results?: { status: number }[] };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.results?.map((result) => result.status)).toEqual([400]);
    expect(readHandoffs(db)).toHaveLength(0);
  } finally {
    if (prior === undefined) delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
    else process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = prior;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw dispatch remains blocked after the workflow run deadline expires", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-native-dispatch-expired-"));
  const { services, db } = await setupHarness(root, { withRunRegistry: true });
  try {
    const response = await runWorkflow(services, root, {
      delay_ms: 30,
      run_timeout_ms: 5,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome?: string;
      runResult?: { results?: { status: number }[] };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.results?.map((result) => result.status)).toEqual([408]);
    expect(readHandoffs(db)).toHaveLength(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
