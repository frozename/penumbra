import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import {
  readWorkflowLastFired,
  runWorkflowTriggerSweep,
  startWorkflowTriggerSweeper,
  type WorkflowTriggerSweeperOpts,
  type WorkflowTriggerSweepState,
} from "@src/sweepers/workflow-trigger.js";

type Trigger = {
  kind: "state-threshold";
  metric:
    | "queue-idle-min"
    | "time-since-last-handoff-min"
    | "pending-handoffs"
    | "commits-since-last-handoff"
    | "context-window-percent"
    | "pending-review-lanes";
  op: ">" | "<";
  value: number;
};

function spec(
  name: string,
  trigger: Trigger,
): {
  name: string;
  description: string;
  triggers: Trigger[];
  recall: never[];
  output: never[];
  run: { kind: string; template: string };
} {
  return {
    name,
    description: "",
    triggers: [trigger],
    recall: [],
    output: [],
    run: { kind: "markdown-template", template: "" },
  };
}

function fakeRegistry(specs: { name: string; triggers: Trigger[] }[]): {
  list: () => { name: string; triggers: Trigger[] }[];
  findByTrigger: () => never[];
  getEntry: () => undefined;
  errors: readonly unknown[];
} {
  return {
    list: () => specs,
    findByTrigger: () => [],
    getEntry: () => undefined,
    errors: [] as readonly unknown[],
  };
}

const ZERO_METRICS = {
  "queue-idle-min": 0,
  "time-since-last-handoff-min": 0,
  "pending-handoffs": 0,
  "commits-since-last-handoff": 0,
  "context-window-percent": 0,
  "pending-review-lanes": 0,
};

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(1);
  }
}

function makeOpts(
  overrides: Partial<WorkflowTriggerSweeperOpts> & {
    specs: { name: string; triggers: Trigger[] }[];
    metrics?: typeof ZERO_METRICS;
    warns?: unknown[];
  },
): WorkflowTriggerSweeperOpts {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry(overrides.specs),
    computeMetrics: () => overrides.metrics ?? ZERO_METRICS,
    runWorkflow: (name: string): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    },
    log: {
      warn: (obj: unknown) => {
        overrides.warns?.push(obj);
      },
    },
    ...overrides,
  };
  (opts as unknown as { __calls: string[] }).__calls = calls;
  return opts;
}

test("no matches → fired and matched empty, runWorkflow not called", async () => {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("idle", { kind: "state-threshold", metric: "queue-idle-min", op: ">", value: 30 }),
    ]),
    computeMetrics: () => ZERO_METRICS,
    runWorkflow: (name: string): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    },
  };
  const state = { lastFired: new Map<string, number>() };
  const result = await runWorkflowTriggerSweep(opts, state, () => new Date("2026-05-04T12:00:00Z"));
  expect(result.matched).toEqual([]);
  expect(result.fired).toEqual([]);
  expect(calls).toEqual([]);
});

test("one match, no prior fire → fires once", async () => {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("always", { kind: "state-threshold", metric: "pending-handoffs", op: ">", value: -1 }),
    ]),
    computeMetrics: () => ZERO_METRICS,
    runWorkflow: (name: string): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    },
  };
  const state = { lastFired: new Map<string, number>() };
  const result = await runWorkflowTriggerSweep(opts, state, () => new Date("2026-05-04T12:00:00Z"));
  expect(result.matched).toEqual(["always"]);
  expect(result.fired).toEqual(["always"]);
  expect(calls).toEqual(["always"]);
});

test("cooldown holds → second call matches but does not fire", async () => {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("always", { kind: "state-threshold", metric: "pending-handoffs", op: ">", value: -1 }),
    ]),
    computeMetrics: () => ZERO_METRICS,
    runWorkflow: (name: string): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    },
  };
  const state = { lastFired: new Map<string, number>() };
  const now = (): Date => new Date("2026-05-04T12:00:00Z");

  const first = await runWorkflowTriggerSweep(opts, state, now);
  expect(first.fired).toEqual(["always"]);
  const second = await runWorkflowTriggerSweep(opts, state, now);
  expect(second.matched).toEqual(["always"]);
  expect(second.fired).toEqual([]);
  expect(calls).toEqual(["always"]);
});

test("re-arm interval elapses while still crossed → fires again", async () => {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("always", { kind: "state-threshold", metric: "pending-handoffs", op: ">", value: -1 }),
    ]),
    computeMetrics: () => ZERO_METRICS,
    runWorkflow: (name: string): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    },
  };
  const state: WorkflowTriggerSweepState = { lastFired: new Map<string, number>() };

  await runWorkflowTriggerSweep(opts, state, () => new Date("2026-05-04T12:00:00Z"));
  expect(calls).toEqual(["always"]);
  // 6 minutes later the debounce has elapsed but the threshold never uncrossed.
  await runWorkflowTriggerSweep(opts, state, () => new Date("2026-05-04T12:06:00Z"));
  expect(calls).toEqual(["always"]);
  // Past the 6 h re-arm the workflow is allowed to fire again.
  await runWorkflowTriggerSweep(opts, state, () => new Date("2026-05-04T18:01:00Z"));
  expect(calls).toEqual(["always", "always"]);
});

test("stale lastFired entries are evicted on a sweep tick", async () => {
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([]),
    computeMetrics: () => ZERO_METRICS,
    runWorkflow: (): Promise<void> => Promise.resolve(),
  };
  const state = {
    lastFired: new Map<string, number>([
      ["stale", Date.parse("2026-05-03T12:00:00Z")],
      ["fresh", Date.parse("2026-05-04T11:59:30Z")],
    ]),
  };

  const result = await runWorkflowTriggerSweep(opts, state, () => new Date("2026-05-04T12:00:00Z"));

  expect(result.fired).toEqual([]);
  expect(state.lastFired.has("stale")).toBe(false);
  expect(state.lastFired.has("fresh")).toBe(true);
});

test("runWorkflow throws → sweep continues, fired counts the attempt, warn emitted", async () => {
  const warns: unknown[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("boom", { kind: "state-threshold", metric: "pending-handoffs", op: ">", value: -1 }),
    ]),
    computeMetrics: () => ZERO_METRICS,
    runWorkflow: (): Promise<void> => {
      throw new Error("kaboom");
    },
    log: {
      warn: (obj) => {
        warns.push(obj);
      },
    },
  };
  const state = { lastFired: new Map<string, number>() };
  const result = await runWorkflowTriggerSweep(opts, state, () => new Date("2026-05-04T12:00:00Z"));
  expect(result.fired).toEqual(["boom"]);
  expect(warns.length).toBe(1);
});

test("pending-review-lanes fires once and respects cooldown", async () => {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("review-backlog", {
        kind: "state-threshold",
        metric: "pending-review-lanes",
        op: ">",
        value: 0,
      }),
    ]),
    computeMetrics: () => ({ ...ZERO_METRICS, "pending-review-lanes": 2 }),
    runWorkflow: (name: string): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    },
  };
  const state = { lastFired: new Map<string, number>() };
  const now = (): Date => new Date("2026-05-04T12:00:00Z");

  const first = await runWorkflowTriggerSweep(opts, state, now);
  expect(first.matched).toEqual(["review-backlog"]);
  expect(first.fired).toEqual(["review-backlog"]);

  const second = await runWorkflowTriggerSweep(opts, state, now);
  expect(second.matched).toEqual(["review-backlog"]);
  expect(second.fired).toEqual([]);
  expect(calls).toEqual(["review-backlog"]);
});

test("threshold that stays crossed fires once, not once per cooldown", async () => {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("session-handoff", {
        kind: "state-threshold",
        metric: "time-since-last-handoff-min",
        op: ">",
        value: 25,
      }),
    ]),
    computeMetrics: () => ({ ...ZERO_METRICS, "time-since-last-handoff-min": 90 }),
    runWorkflow: (name: string): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    },
  };
  const state: WorkflowTriggerSweepState = { lastFired: new Map<string, number>() };
  const base = Date.parse("2026-05-04T12:00:00Z");
  for (let i = 0; i < 10; i++) {
    await runWorkflowTriggerSweep(opts, state, () => new Date(base + i * 6 * 60_000));
  }
  expect(calls).toEqual(["session-handoff"]);
});

test("threshold that uncrosses and re-crosses fires again", async () => {
  const calls: string[] = [];
  let idle = 90;
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("session-handoff", {
        kind: "state-threshold",
        metric: "time-since-last-handoff-min",
        op: ">",
        value: 25,
      }),
    ]),
    computeMetrics: () => ({ ...ZERO_METRICS, "time-since-last-handoff-min": idle }),
    runWorkflow: (name: string): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    },
  };
  const state: WorkflowTriggerSweepState = { lastFired: new Map<string, number>() };
  const at =
    (min: number): (() => Date) =>
    (): Date =>
      new Date(Date.parse("2026-05-04T12:00:00Z") + min * 60_000);

  await runWorkflowTriggerSweep(opts, state, at(0));
  idle = 0;
  await runWorkflowTriggerSweep(opts, state, at(6));
  idle = 90;
  await runWorkflowTriggerSweep(opts, state, at(12));
  expect(calls).toEqual(["session-handoff", "session-handoff"]);
});

test("sweeper seeds lastFired from durable state so a restart does not re-fire inside the cooldown", async () => {
  const calls: string[] = [];
  const firedAt = Date.parse("2026-05-04T12:00:00Z");
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("session-handoff", {
        kind: "state-threshold",
        metric: "time-since-last-handoff-min",
        op: ">",
        value: 25,
      }),
    ]),
    computeMetrics: () => ({ ...ZERO_METRICS, "time-since-last-handoff-min": 90 }),
    runWorkflow: (name: string): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    },
    seedLastFired: (): Map<string, number> => new Map([["session-handoff", firedAt]]),
  };
  const stop = startWorkflowTriggerSweeper(opts, 5, () => new Date(firedAt + 500));
  await Bun.sleep(40);
  stop();
  expect(calls).toEqual([]);
});

test("a tick is skipped while the previous sweep is still running", async () => {
  let metricsCalls = 0;
  let release: (() => void) | undefined;
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("slow", { kind: "state-threshold", metric: "pending-handoffs", op: ">", value: -1 }),
    ]),
    computeMetrics: () => {
      metricsCalls++;
      return ZERO_METRICS;
    },
    runWorkflow: (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  };
  const stop = startWorkflowTriggerSweeper(opts, 5);
  await Bun.sleep(60);
  expect(metricsCalls).toBe(1);
  release?.();
  stop();
});

test("in-flight fence releases after the sweep resolves", async () => {
  let metricsCalls = 0;
  let release: (() => void) | undefined;
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("slow", { kind: "state-threshold", metric: "pending-handoffs", op: ">", value: -1 }),
    ]),
    computeMetrics: () => {
      metricsCalls++;
      return ZERO_METRICS;
    },
    runWorkflow: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  };
  const stop = startWorkflowTriggerSweeper(opts, 5);
  await waitFor(() => release !== undefined);
  release?.();
  await waitFor(() => metricsCalls >= 2);
  stop();
  expect(metricsCalls).toBeGreaterThanOrEqual(2);
});

test("in-flight fence releases after the sweep rejects", async () => {
  let metricsCalls = 0;
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([]),
    computeMetrics: () => {
      metricsCalls++;
      if (metricsCalls === 1) throw new Error("expected rejection");
      return ZERO_METRICS;
    },
    runWorkflow: (): Promise<void> => Promise.resolve(),
  };
  const stop = startWorkflowTriggerSweeper(opts, 5);
  await waitFor(() => metricsCalls >= 2);
  stop();
  expect(metricsCalls).toBeGreaterThanOrEqual(2);
});

test("durable lastFired reader keeps newest valid rows and ignores malformed values", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE t0_events (ts TEXT, event_type TEXT, payload_json TEXT)");
  const insert = db.query(
    "INSERT INTO t0_events (ts, event_type, payload_json) VALUES (?1, ?2, ?3)",
  );
  insert.run("2026-05-04T12:00:00Z", "workflow.outcome", '{"workflow_name":"alpha"}');
  insert.run("2026-05-04T13:00:00Z", "workflow.outcome", '{"workflow_name":"alpha"}');
  insert.run("not-a-date", "workflow.outcome", '{"workflow_name":"alpha"}');
  insert.run("2026-05-04T14:00:00Z", "workflow.outcome", '{"workflow_name":"beta"}');
  insert.run("2026-05-04T15:00:00Z", "workflow.outcome", "{");
  insert.run("2026-05-04T15:00:00Z", "workflow.outcome", '{"workflow_name":42}');
  insert.run("2026-05-04T15:00:00Z", "workflow.outcome", '{"workflow_name":""}');
  insert.run("2026-05-04T16:00:00Z", "other.event", '{"workflow_name":"ignored"}');

  expect(readWorkflowLastFired(db)).toEqual(
    new Map([
      ["alpha", Date.parse("2026-05-04T13:00:00Z")],
      ["beta", Date.parse("2026-05-04T14:00:00Z")],
    ]),
  );
  db.close();
});

test("durable lastFired reader returns an empty map when the table is unavailable", () => {
  const db = new Database(":memory:");
  expect(readWorkflowLastFired(db)).toEqual(new Map());
  db.close();
});
