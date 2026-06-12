import { expect, test } from "bun:test";
import {
  runWorkflowTriggerSweep,
  type WorkflowTriggerSweeperOpts,
} from "../../src/sweepers/workflow-trigger.js";

type Trigger = {
  kind: "state-threshold";
  metric:
    | "queue-idle-min"
    | "time-since-last-handoff-min"
    | "pending-handoffs"
    | "commits-since-last-handoff"
    | "pending-review-lanes";
  op: ">" | "<";
  value: number;
};

function spec(name: string, trigger: Trigger) {
  return {
    name,
    description: "",
    triggers: [trigger],
    recall: [],
    output: [],
    run: { kind: "markdown-template", template: "" },
  };
}

function fakeRegistry(specs: any[]) {
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
  "pending-review-lanes": 0,
};

function makeOpts(
  overrides: Partial<WorkflowTriggerSweeperOpts> & {
    specs: any[];
    metrics?: typeof ZERO_METRICS;
    warns?: any[];
  },
): WorkflowTriggerSweeperOpts {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry(overrides.specs),
    computeMetrics: () => overrides.metrics ?? ZERO_METRICS,
    runWorkflow: async (name: string) => {
      calls.push(name);
    },
    log: {
      warn: (obj: unknown) => {
        overrides.warns?.push(obj);
      },
    },
    ...overrides,
  };
  (opts as any).__calls = calls;
  return opts;
}

test("no matches → fired and matched empty, runWorkflow not called", async () => {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("idle", { kind: "state-threshold", metric: "queue-idle-min", op: ">", value: 30 }),
    ]),
    computeMetrics: () => ZERO_METRICS,
    runWorkflow: async (name) => {
      calls.push(name);
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
    runWorkflow: async (name) => {
      calls.push(name);
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
    runWorkflow: async (name) => {
      calls.push(name);
    },
  };
  const state = { lastFired: new Map<string, number>() };
  const now = () => new Date("2026-05-04T12:00:00Z");

  const first = await runWorkflowTriggerSweep(opts, state, now);
  expect(first.fired).toEqual(["always"]);
  const second = await runWorkflowTriggerSweep(opts, state, now);
  expect(second.matched).toEqual(["always"]);
  expect(second.fired).toEqual([]);
  expect(calls).toEqual(["always"]);
});

test("cooldown elapses → fires again", async () => {
  const calls: string[] = [];
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([
      spec("always", { kind: "state-threshold", metric: "pending-handoffs", op: ">", value: -1 }),
    ]),
    computeMetrics: () => ZERO_METRICS,
    runWorkflow: async (name) => {
      calls.push(name);
    },
  };
  const state = { lastFired: new Map<string, number>() };

  await runWorkflowTriggerSweep(opts, state, () => new Date("2026-05-04T12:00:00Z"));
  expect(calls).toEqual(["always"]);
  // 6 minutes later, cooldown (default 5 min) has elapsed
  await runWorkflowTriggerSweep(opts, state, () => new Date("2026-05-04T12:06:00Z"));
  expect(calls).toEqual(["always", "always"]);
});

test("stale lastFired entries are evicted on a sweep tick", async () => {
  const opts: WorkflowTriggerSweeperOpts = {
    registry: fakeRegistry([]),
    computeMetrics: () => ZERO_METRICS,
    runWorkflow: async () => {},
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
    runWorkflow: async () => {
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
    runWorkflow: async (name) => {
      calls.push(name);
    },
  };
  const state = { lastFired: new Map<string, number>() };
  const now = () => new Date("2026-05-04T12:00:00Z");

  const first = await runWorkflowTriggerSweep(opts, state, now);
  expect(first.matched).toEqual(["review-backlog"]);
  expect(first.fired).toEqual(["review-backlog"]);

  const second = await runWorkflowTriggerSweep(opts, state, now);
  expect(second.matched).toEqual(["review-backlog"]);
  expect(second.fired).toEqual([]);
  expect(calls).toEqual(["review-backlog"]);
});
