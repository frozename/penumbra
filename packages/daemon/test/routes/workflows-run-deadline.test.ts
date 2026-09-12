import { loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workflowsRunRoute } from "@src/routes/workflows.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // bundled sqlite is fine
  }
}

type WorkflowRunsRegistry = ReturnType<typeof createWorkflowRunsRegistry>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

type DeadlineControl = {
  wait: Promise<unknown>;
};

type TestGlobal = typeof globalThis & {
  __penumbraWorkflowRunDeadlineControls?: Record<string, DeadlineControl>;
};

type TimerTracker = {
  timeouts: (number | undefined)[];
  handles: ReturnType<typeof setTimeout>[];
  cleared: ReturnType<typeof setTimeout>[];
  restore: () => void;
};

function mockServices(partial: Record<string, unknown>): Services {
  const noopLog = {
    error: (): undefined => undefined,
    warn: (): undefined => undefined,
    info: (): undefined => undefined,
    debug: (): undefined => undefined,
    trace: (): undefined => undefined,
    fatal: (): undefined => undefined,
  };
  return { ...partial, log: noopLog } as unknown as Services;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] | undefined;
  let reject: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) throw new Error("deferred init failed");
  return { promise, resolve, reject };
}

function registerControl(key: string, control: DeadlineControl): void {
  const g = globalThis as TestGlobal;
  g.__penumbraWorkflowRunDeadlineControls ??= {};
  g.__penumbraWorkflowRunDeadlineControls[key] = control;
}

function unregisterControl(key: string): void {
  delete (globalThis as TestGlobal).__penumbraWorkflowRunDeadlineControls?.[key];
}

function restoreEnv(prior: string | undefined): void {
  if (prior === undefined) delete process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS;
  else process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS = prior;
}

function trackTimers(): TimerTracker {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const callSetTimeout = originalSetTimeout as unknown as (
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ) => ReturnType<typeof setTimeout>;
  const timeouts: (number | undefined)[] = [];
  const handles: ReturnType<typeof setTimeout>[] = [];
  const cleared: ReturnType<typeof setTimeout>[] = [];
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const handle = callSetTimeout(callback, timeout, ...args);
    timeouts.push(timeout);
    handles.push(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle !== undefined) cleared.push(handle);
    originalClearTimeout(handle);
  }) as typeof clearTimeout;
  return {
    timeouts,
    handles,
    cleared,
    restore: (): void => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      for (const handle of handles) originalClearTimeout(handle);
    },
  };
}

const CONTROLLED_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'controlled',
  description: 'controlled run deadline workflow',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async (ctx) => {
  const key = String((ctx as { args?: { key?: unknown } }).args?.key ?? '');
  const controls = (globalThis as typeof globalThis & {
    __penumbraWorkflowRunDeadlineControls?: Record<string, { wait: Promise<unknown> }>;
  }).__penumbraWorkflowRunDeadlineControls;
  const control = controls?.[key];
  if (!control) throw new Error(\`missing deadline test control \${key}\`);
  return await control.wait;
};
`;

const IMMEDIATE_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'immediate',
  description: 'settles inside the run deadline',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async () => ({ payload: { unchanged: true } });
`;

const DEADLINE_CHECK_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'deadline-check',
  description: 'returns the ctx deadline state',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async (ctx) => {
  const dl = ctx.deadline();
  return { remaining_ms: dl.remaining_ms, expired: dl.expired };
};
`;

const RAW_CHAINSTART_AFTER_EXPIRY_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'raw-chainstart-after-expiry',
  description: 'calls raw chainStart after run deadline expiry',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async (ctx) => {
  await new Promise(resolve => setTimeout(resolve, 100));
  const rawCtx = ctx as { chainStart: (input: unknown) => Promise<Response> | Response };
  const res = await rawCtx.chainStart({
    initial_agent: 'codex',
    message: 'too late',
    dispatch_kind: 'workflow',
  });
  return { status: res.status, ok: res.ok };
};
`;

const STRICT_DEADLINE_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'strict-deadline',
  description: 'strict args with a daemon-owned run deadline',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const inputSchema = {
  parse(input: unknown) {
    const result = this.safeParse(input);
    if (!result.success) throw new Error('invalid');
    return result.data;
  },
  safeParse(input: unknown) {
    const raw = (input ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(raw).filter((key) => key !== 'label');
    const issues: Array<{ path: Array<string | number>; message: string; expected?: string }> = [];
    if (unknown.length > 0) {
      issues.push({ path: [], message: 'Unrecognized key(s) in object' });
    }
    if (typeof raw.label !== 'string') {
      issues.push({ path: ['label'], message: 'Expected string', expected: 'string' });
    }
    if (issues.length > 0) return { success: false as const, error: { issues } };
    return { success: true as const, data: { label: raw.label } };
  },
};
export const fn: WorkflowFn = async (ctx) => {
  const initialDeadline = ctx.deadline();
  await new Promise(resolve => setTimeout(resolve, 40));
  const rawCtx = ctx as { chainStart: (input: unknown) => Promise<Response> | Response };
  const res = await rawCtx.chainStart({
    initial_agent: 'codex',
    message: 'too late',
    dispatch_kind: 'workflow',
  });
  return {
    args: ctx.args,
    initial_deadline: initialDeadline,
    expired_deadline: ctx.deadline(),
    chain_start_status: res.status,
  };
};
`;

const TRANSFORMING_DEADLINE_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'transforming-deadline',
  description: 'transforms args while preserving a daemon-owned run deadline',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const inputSchema = {
  parse(input: unknown) {
    const result = this.safeParse(input);
    if (!result.success) throw new Error('invalid');
    return result.data;
  },
  safeParse(input: unknown) {
    const raw = (input ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(raw).filter((key) => key !== 'label' && key !== 'attempts');
    if (unknown.length > 0) {
      return {
        success: false as const,
        error: { issues: [{ path: [], message: 'Unrecognized key(s) in object' }] },
      };
    }
    return {
      success: true as const,
      data: {
        label: typeof raw.label === 'string' ? raw.label.trim().toUpperCase() : 'DEFAULT',
        attempts: typeof raw.attempts === 'number' ? raw.attempts + 1 : 4,
      },
    };
  },
};
export const fn: WorkflowFn = async (ctx) => ({ args: ctx.args, deadline: ctx.deadline() });
`;

const STRIPPING_DEADLINE_WORKFLOW = `import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'stripping-deadline',
  description: 'strips unknown args while preserving a daemon-owned run deadline',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const inputSchema = {
  parse(input: unknown) {
    const result = this.safeParse(input);
    if (!result.success) throw new Error('invalid');
    return result.data;
  },
  safeParse(input: unknown) {
    const raw = (input ?? {}) as Record<string, unknown>;
    return {
      success: true as const,
      data: {
        label: typeof raw.label === 'string' ? raw.label.trim().toUpperCase() : 'DEFAULT',
      },
    };
  },
};
export const fn: WorkflowFn = async (ctx) => ({ args: ctx.args, deadline: ctx.deadline() });
`;

async function setup(root: string): Promise<{
  services: Services;
  workflowRuns: WorkflowRunsRegistry;
}> {
  writeFileSync(join(root, ".penumbra-project"), "test-project\n");
  mkdirSync(join(root, "playbooks"), { recursive: true });
  mkdirSync(join(root, "workflows/controlled"), { recursive: true });
  mkdirSync(join(root, "workflows/immediate"), { recursive: true });
  mkdirSync(join(root, "workflows/deadline-check"), { recursive: true });
  mkdirSync(join(root, "workflows/raw-chainstart-after-expiry"), { recursive: true });
  mkdirSync(join(root, "workflows/strict-deadline"), { recursive: true });
  mkdirSync(join(root, "workflows/transforming-deadline"), { recursive: true });
  mkdirSync(join(root, "workflows/stripping-deadline"), { recursive: true });
  writeFileSync(join(root, "workflows/controlled/workflow.ts"), CONTROLLED_WORKFLOW);
  writeFileSync(join(root, "workflows/immediate/workflow.ts"), IMMEDIATE_WORKFLOW);
  writeFileSync(join(root, "workflows/deadline-check/workflow.ts"), DEADLINE_CHECK_WORKFLOW);
  writeFileSync(
    join(root, "workflows/raw-chainstart-after-expiry/workflow.ts"),
    RAW_CHAINSTART_AFTER_EXPIRY_WORKFLOW,
  );
  writeFileSync(join(root, "workflows/strict-deadline/workflow.ts"), STRICT_DEADLINE_WORKFLOW);
  writeFileSync(
    join(root, "workflows/transforming-deadline/workflow.ts"),
    TRANSFORMING_DEADLINE_WORKFLOW,
  );
  writeFileSync(
    join(root, "workflows/stripping-deadline/workflow.ts"),
    STRIPPING_DEADLINE_WORKFLOW,
  );
  const reg = await buildRegistry({
    playbooksDir: join(root, "playbooks"),
    workflowsDir: join(root, "workflows"),
  });
  const db = freshDb();
  const workflowRuns = createWorkflowRunsRegistry({
    uuid: () => "wfrun-1",
    clock: () => new Date("2026-04-26T00:00:00Z"),
    db,
    storageRoot: root,
  });
  return {
    services: mockServices({
      workflowRegistry: reg,
      workflowRuns,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      settings: { storageRoot: root },
    }),
    workflowRuns,
  };
}

async function runWorkflow(opts: {
  services: Services;
  root: string;
  name: string;
  wait?: boolean;
  args?: Record<string, unknown>;
}): Promise<Response> {
  return await workflowsRunRoute(
    new Request("http://localhost/workflows/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: opts.name,
        cwd: opts.root,
        ...(opts.wait === undefined ? {} : { wait: opts.wait }),
        ...(opts.args === undefined ? {} : { args: opts.args }),
      }),
    }),
    opts.services,
  );
}

async function routeResponseWithin(
  routePromise: Promise<Response>,
  ms: number,
): Promise<Response | null> {
  return await Promise.race([routePromise, Bun.sleep(ms).then(() => null)]);
}

async function waitForRun(
  workflowRuns: WorkflowRunsRegistry,
  workflowRunId: string,
  timeoutMs = 500,
): Promise<NonNullable<Awaited<ReturnType<WorkflowRunsRegistry["waitForResult"]>>>> {
  const record = await workflowRuns.waitForResult(workflowRunId, timeoutMs);
  expect(record).not.toBeNull();
  return record!;
}

test("wait:true returns 202 with a run handle when the run outlives the deadline, then persists completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-deadline-"));
  const prior = process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS;
  const key = "complete-after-deadline";
  const control = deferred<unknown>();
  process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS = "30";
  registerControl(key, { wait: control.promise });
  let routePromise: Promise<Response> | undefined;
  try {
    const { services, workflowRuns } = await setup(root);
    routePromise = runWorkflow({
      services,
      root,
      name: "controlled",
      wait: true,
      args: { key },
    });
    const res = await routeResponseWithin(routePromise, 250);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(202);
    const body = (await res?.json()) as {
      workflow_run_id?: string;
      started_at?: unknown;
      status?: string;
      wait_deadline_exceeded?: boolean;
    };
    expect(body).toEqual({
      workflow_run_id: "wfrun-1",
      started_at: expect.any(Number) as unknown,
      status: "running",
      wait_deadline_exceeded: true,
    });

    control.resolve({ slow: true });
    const record = await waitForRun(workflowRuns, "wfrun-1");
    expect(record.status).toBe("completed");
    expect(record.result).toMatchObject({
      outcome: "success",
      runResult: { slow: true },
    });
  } finally {
    unregisterControl(key);
    control.resolve({ cleanup: true });
    if (routePromise) await Promise.race([routePromise.catch(() => undefined), Bun.sleep(50)]);
    restoreEnv(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait:true timeout keeps the same run attached when late failure settles failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-deadline-fail-"));
  const prior = process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS;
  const key = "fail-after-deadline";
  const control = deferred<unknown>();
  process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS = "30";
  registerControl(key, { wait: control.promise });
  let routePromise: Promise<Response> | undefined;
  try {
    const { services, workflowRuns } = await setup(root);
    routePromise = runWorkflow({
      services,
      root,
      name: "controlled",
      wait: true,
      args: { key },
    });
    const res = await routeResponseWithin(routePromise, 250);
    expect(res?.status).toBe(202);
    expect(await res?.json()).toMatchObject({
      workflow_run_id: "wfrun-1",
      status: "running",
      wait_deadline_exceeded: true,
    });

    control.reject(new Error("late boom"));
    const record = await waitForRun(workflowRuns, "wfrun-1");
    expect(record.status).toBe("failed");
    expect(record.error).toMatchObject({
      outcome: "run_error",
      errorMessage: "late boom",
    });
  } finally {
    unregisterControl(key);
    control.resolve({ cleanup: true });
    if (routePromise) await Promise.race([routePromise.catch(() => undefined), Bun.sleep(50)]);
    restoreEnv(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait:true returns workflow_run_id alongside the unchanged normal result and clears the timer", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-handle-"));
  const prior = process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS;
  process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS = "30000";
  let timers: TimerTracker | undefined;
  try {
    const { services } = await setup(root);
    timers = trackTimers();
    const res = await runWorkflow({ services, root, name: "immediate", wait: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      runResult?: unknown;
      workflow_run_id?: string;
    };
    expect(body.workflow_run_id).toBe("wfrun-1");
    expect(body.outcome).toBe("success");
    expect(body.runResult).toEqual({ payload: { unchanged: true } });
    expect(timers.timeouts).toEqual([30000]);
    const deadlineHandle = timers.handles[0];
    expect(deadlineHandle).toBeDefined();
    if (deadlineHandle) expect(timers.cleared).toContain(deadlineHandle);
  } finally {
    timers?.restore();
    restoreEnv(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait:false still returns the detached handle without installing the wait deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-wait-false-"));
  const key = "wait-false";
  const control = deferred<unknown>();
  registerControl(key, { wait: control.promise });
  let timers: TimerTracker | undefined;
  try {
    const { services, workflowRuns } = await setup(root);
    timers = trackTimers();
    const res = await runWorkflow({
      services,
      root,
      name: "controlled",
      wait: false,
      args: { key },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workflow_run_id: "wfrun-1",
      started_at: expect.any(Number) as unknown,
    });
    expect(timers.timeouts).toEqual([]);

    control.resolve({ detached: true });
    const record = await waitForRun(workflowRuns, "wfrun-1");
    expect(record.status).toBe("completed");
  } finally {
    timers?.restore();
    unregisterControl(key);
    control.resolve({ cleanup: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait:true deadline env uses default for invalid values and caps oversized values", async () => {
  const cases: [string, string | undefined, number][] = [
    ["missing", undefined, 240000],
    ["blank", "", 240000],
    ["nonnumeric", "abc", 240000],
    ["zero", "0", 240000],
    ["negative", "-3", 240000],
    ["oversized", "999999", 240000],
    ["downward override", "42.8", 42],
  ];
  const prior = process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS;
  try {
    for (const [label, value, expectedTimeout] of cases) {
      const root = mkdtempSync(join(tmpdir(), `wf-run-deadline-env-${label}-`));
      let timers: TimerTracker | undefined;
      try {
        if (value === undefined) delete process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS;
        else process.env.PENUMBRA_WORKFLOW_RUN_WAIT_DEADLINE_MS = value;
        const { services } = await setup(root);
        timers = trackTimers();
        const res = await runWorkflow({ services, root, name: "immediate", wait: true });
        expect(res.status).toBe(200);
        expect(timers.timeouts).toEqual([expectedTimeout]);
        const deadlineHandle = timers.handles[0];
        expect(deadlineHandle).toBeDefined();
        if (deadlineHandle) expect(timers.cleared).toContain(deadlineHandle);
      } finally {
        timers?.restore();
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    restoreEnv(prior);
  }
});

// ---------------------------------------------------------------------------
// Run-level deadline (Task 10.1) — args.run_timeout_ms + raw chainStart guard
// ---------------------------------------------------------------------------

test("valid args.run_timeout_ms activates the run-level deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-deadline-valid-"));
  try {
    const { services } = await setup(root);
    const res = await runWorkflow({
      services,
      root,
      name: "deadline-check",
      wait: true,
      args: { run_timeout_ms: 5000 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      runResult?: { remaining_ms?: number | null; expired?: boolean };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.remaining_ms).not.toBeNull();
    expect(body.runResult?.expired).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed args.run_timeout_ms values retain unbounded behavior", async () => {
  const cases: [string, unknown][] = [
    ["negative", -1],
    ["zero", 0],
    ["float", 1.5],
    ["string", "5000"],
    ["null", null],
    ["object", { ms: 5000 }],
  ];
  for (const [label, value] of cases) {
    const root = mkdtempSync(join(tmpdir(), `wf-run-deadline-malformed-${label}-`));
    try {
      const { services } = await setup(root);
      const res = await runWorkflow({
        services,
        root,
        name: "deadline-check",
        wait: true,
        args: { run_timeout_ms: value },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        outcome?: string;
        runResult?: { remaining_ms?: number | null; expired?: boolean };
      };
      expect(body.outcome).toBe("success");
      expect(body.runResult?.remaining_ms).toBeNull();
      expect(body.runResult?.expired).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("raw daemon ctx.chainStart is blocked after run deadline expiry", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-deadline-raw-cs-"));
  try {
    const { services, workflowRuns } = await setup(root);
    const res = await runWorkflow({
      services,
      root,
      name: "raw-chainstart-after-expiry",
      wait: true,
      args: { run_timeout_ms: 50 },
    });
    // The workflow sleeps 100ms (past the 50ms deadline), then calls raw chainStart.
    // The guard should return 408 before chainStartFromInput is called.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      runResult?: { status?: number; ok?: boolean };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.status).toBe(408);
    expect(body.runResult?.ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent run_timeout_ms leaves the raw chainStart unbounded (no 408)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-deadline-no-rtm-"));
  try {
    const { services } = await setup(root);
    const res = await runWorkflow({
      services,
      root,
      name: "deadline-check",
      wait: true,
      args: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      runResult?: { remaining_ms?: number | null; expired?: boolean };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.remaining_ms).toBeNull();
    expect(body.runResult?.expired).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict workflow args keep run_timeout_ms runtime-only and enforce the raw chainStart guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-deadline-strict-"));
  try {
    const { services } = await setup(root);
    const res = await runWorkflow({
      services,
      root,
      name: "strict-deadline",
      wait: true,
      args: { label: "ordinary", run_timeout_ms: 20 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      runResult?: {
        args?: Record<string, unknown>;
        initial_deadline?: { remaining_ms?: number | null; expired?: boolean };
        expired_deadline?: { remaining_ms?: number | null; expired?: boolean };
        chain_start_status?: number;
      };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.args).toEqual({ label: "ordinary" });
    expect(body.runResult?.initial_deadline?.remaining_ms).not.toBeNull();
    expect(body.runResult?.initial_deadline?.expired).toBe(false);
    expect(body.runResult?.expired_deadline?.remaining_ms).toBe(0);
    expect(body.runResult?.expired_deadline?.expired).toBe(true);
    expect(body.runResult?.chain_start_status).toBe(408);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict schema defaults and transforms valid args while keeping the runtime deadline active", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-deadline-transform-"));
  try {
    const { services } = await setup(root);
    const res = await runWorkflow({
      services,
      root,
      name: "transforming-deadline",
      wait: true,
      args: { label: "  ordinary  ", run_timeout_ms: 5000 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      runResult?: {
        args?: Record<string, unknown>;
        deadline?: { remaining_ms?: number | null; expired?: boolean };
      };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.args).toEqual({ label: "ORDINARY", attempts: 4 });
    expect(body.runResult?.deadline?.remaining_ms).not.toBeNull();
    expect(body.runResult?.deadline?.expired).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stripping schema omits ordinary unknown args while keeping the runtime deadline active", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-deadline-strip-"));
  try {
    const { services } = await setup(root);
    const res = await runWorkflow({
      services,
      root,
      name: "stripping-deadline",
      wait: true,
      args: { label: "  ordinary  ", ignored: "drop-me", run_timeout_ms: 5000 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome?: string;
      runResult?: {
        args?: Record<string, unknown>;
        deadline?: { remaining_ms?: number | null; expired?: boolean };
      };
    };
    expect(body.outcome).toBe("success");
    expect(body.runResult?.args).toEqual({ label: "ORDINARY" });
    expect(body.runResult?.args).not.toHaveProperty("ignored");
    expect(body.runResult?.args).not.toHaveProperty("run_timeout_ms");
    const remainingMs = body.runResult?.deadline?.remaining_ms;
    expect(typeof remainingMs).toBe("number");
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(5000);
    expect(body.runResult?.deadline?.expired).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict workflow schemas still reject unknown ordinary args", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-run-deadline-strict-unknown-"));
  try {
    const { services } = await setup(root);
    const res = await runWorkflow({
      services,
      root,
      name: "strict-deadline",
      wait: true,
      args: { label: "ordinary", unexpected: true, run_timeout_ms: 5000 },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_args" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent or malformed runtime budgets remain unbounded under a strict schema", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["absent", {}],
    ["negative", { run_timeout_ms: -1 }],
    ["zero", { run_timeout_ms: 0 }],
    ["float", { run_timeout_ms: 1.5 }],
    ["string", { run_timeout_ms: "5000" }],
    ["null", { run_timeout_ms: null }],
    ["object", { run_timeout_ms: { ms: 5000 } }],
  ];
  for (const [label, runtimeArgs] of cases) {
    const root = mkdtempSync(join(tmpdir(), `wf-run-deadline-strict-${label}-`));
    try {
      const { services } = await setup(root);
      const res = await runWorkflow({
        services,
        root,
        name: "transforming-deadline",
        wait: true,
        args: { label: " ordinary ", ...runtimeArgs },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        outcome?: string;
        runResult?: {
          args?: Record<string, unknown>;
          deadline?: { remaining_ms?: number | null; expired?: boolean };
        };
      };
      expect(body.outcome).toBe("success");
      expect(body.runResult?.args).toEqual({ label: "ORDINARY", attempts: 4 });
      expect(body.runResult?.deadline?.remaining_ms).toBeNull();
      expect(body.runResult?.deadline?.expired).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
