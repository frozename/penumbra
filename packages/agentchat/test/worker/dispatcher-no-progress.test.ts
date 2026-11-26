import type { DispatchEventInput, Logger } from "@penumbra/core";

import { expect, mock, test } from "bun:test";

import {
  createWorkerDispatcher,
  type DispatcherHandoff,
  type WorkerDispatcherDeps,
} from "@src/worker/dispatcher.js";
import type { TerminalReport, TerminalReportStatus } from "@src/worker/terminal-outbox.js";

interface NoProgressHandoff extends DispatcherHandoff {
  ts: string;
  project_id: string | null;
  from_agent: string;
  to_role: string | null;
  message: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  redirected_to: string | null;
  triggered_by_event_id: string | null;
  chain_max_hops: number | null;
  chain_trust_mode: string | null;
  use_worktree?: boolean;
  hop_idx: number;
  chain_task_type?: string | null;
}

const handoff: NoProgressHandoff = {
  handoff_id: "h-no-progress",
  ts: "t",
  project_id: "proj-1",
  conversation_id: "conv-1",
  from_agent: "planner",
  to_agent: "executor",
  to_role: null,
  message: "review this",
  status: "approved",
  resolved_by: null,
  resolved_at: null,
  redirected_to: null,
  triggered_by_event_id: null,
  chain_max_hops: null,
  chain_trust_mode: null,
  use_worktree: true,
  hop_idx: 0,
  chain_task_type: "review_adversarial",
};

function mockCalls<T extends readonly unknown[] = unknown[]>(fn: unknown): T[] {
  return (fn as { mock: { calls: T[] } }).mock.calls;
}

function asLogger(stub: { info: unknown; warn: unknown; debug: unknown }): Logger {
  return stub as unknown as Logger;
}

function makeLog(): Logger {
  return asLogger({ info: mock(), warn: mock(), debug: mock() });
}

interface TurnResultFixture {
  next: null;
  terminatedReason: "no_mention" | "max_hops";
  text: string;
  agent: string;
  meta?: { tool_calls?: number };
}

function turnResult(
  opts: {
    includeMeta?: boolean;
    toolCalls?: number;
    terminatedReason?: "no_mention" | "max_hops";
  } = {},
): TurnResultFixture {
  const result: TurnResultFixture = {
    next: null,
    terminatedReason: opts.terminatedReason ?? "no_mention",
    text: "Running the three review commands now.",
    agent: "executor",
  };
  if (opts.includeMeta ?? true) {
    result.meta = opts.toolCalls === undefined ? {} : { tool_calls: opts.toolCalls };
  }
  return result;
}

function deps(overrides: Partial<WorkerDispatcherDeps> = {}): WorkerDispatcherDeps {
  return {
    claim: mock().mockResolvedValue({ status: "dispatched" }),
    dispatch: mock().mockResolvedValue(turnResult({ toolCalls: 0 })),
    postProgress: mock().mockResolvedValue(undefined),
    complete: mock().mockResolvedValue(undefined),
    markFailed: mock().mockResolvedValue(undefined),
    log: makeLog(),
    concurrency: 1,
    onEvent: mock(),
    onChainEnd: mock(),
    getWorktreeSnapshot: mock().mockResolvedValue({
      worktreeChanged: false,
      dirty: false,
      committed: false,
    }),
    autocommitOnChainEnd: mock().mockResolvedValue(undefined),
    ...overrides,
  };
}

function handoffWith(overrides: Partial<NoProgressHandoff>): NoProgressHandoff {
  return { ...handoff, ...overrides };
}

function handoffWithoutChainTaskType(): NoProgressHandoff {
  const copy = { ...handoff };
  delete copy.chain_task_type;
  return copy;
}

function handoffWithoutUseWorktree(): NoProgressHandoff {
  const copy = { ...handoff };
  delete copy.use_worktree;
  return copy;
}

async function handleAndIdle(
  d: WorkerDispatcherDeps,
  fixture: NoProgressHandoff = handoff,
): Promise<void> {
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(fixture);
  await dispatcher.idle();
}

async function expectCompleted(
  fixture: NoProgressHandoff,
  overrides: Partial<WorkerDispatcherDeps> = {},
): Promise<WorkerDispatcherDeps> {
  const d = deps(overrides);
  await handleAndIdle(d, fixture);
  expect(d.complete).toHaveBeenCalledTimes(1);
  expect(d.markFailed).not.toHaveBeenCalled();
  return d;
}

function dispatchEndEvent(onEvent: unknown): DispatchEventInput {
  const event = mockCalls<[DispatchEventInput]>(onEvent)
    .map((call) => call[0])
    .find((candidate) => candidate.kind === "dispatch.end");
  if (!event) throw new Error("expected dispatch.end event");
  return event;
}

function chainEndPayload(postProgress: unknown): Record<string, unknown> {
  const payload = mockCalls<[string, Record<string, unknown>]>(postProgress)
    .map((call) => call[1])
    .find((candidate) => candidate.type === "chain-end");
  if (!payload) throw new Error("expected chain-end progress payload");
  return payload;
}

function chainEndReason(onChainEnd: unknown): unknown {
  return mockCalls<[NoProgressHandoff, string, ...unknown[]]>(onChainEnd)[0]?.[1];
}

test("a root-hop worktree turn with zero tool calls and no change is failed, not completed", async () => {
  const onEvent = mock();
  const onChainEnd = mock();
  const d = deps({ onEvent, onChainEnd });

  await handleAndIdle(d);

  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledTimes(1);
  const failure = mockCalls<[string, string]>(d.markFailed)[0];
  expect(failure?.[1]).toContain("no_progress");
  const end = dispatchEndEvent(onEvent);
  expect(end.meta?.status).toBe("error");
  expect(end.meta?.worktree_changed).toBe(false);
  expect(chainEndReason(onChainEnd)).toBe("error");
});

test("with reportTerminal wired, the terminal report is a fail with the no_progress reason", async () => {
  const reports: TerminalReport[] = [];
  const reportTerminal = mock((report: TerminalReport): Promise<TerminalReportStatus> => {
    reports.push(report);
    return Promise.resolve("delivered");
  });
  const d = deps({ reportTerminal });

  await handleAndIdle(d);

  expect(reports).toHaveLength(1);
  const report = reports[0];
  expect(report?.outcome).toBe("fail");
  expect(report?.reason).toContain("no_progress");
  expect(report?.dispatch_end.meta?.status).toBe("error");
});

test("the chain-end progress post reports reason error", async () => {
  const postProgress = mock().mockResolvedValue(undefined);
  const d = deps({ postProgress });

  await handleAndIdle(d);

  const payload = chainEndPayload(postProgress);
  expect(payload.reason).toBe("error");
  expect(typeof payload.error).toBe("string");
  if (typeof payload.error === "string") {
    expect(payload.error).toContain("no_progress");
  }
});

test.each([
  ["null", handoffWith({ chain_task_type: null })],
  ["omitted", handoffWithoutChainTaskType()],
] as const)(
  "an untyped dispatch (chain_task_type %s) is also downgraded",
  async (_label, fixture) => {
    const d = deps();

    await handleAndIdle(d, fixture);

    expect(d.markFailed).toHaveBeenCalledTimes(1);
    expect(d.complete).not.toHaveBeenCalled();
  },
);

test("guard: meta.tool_calls is 1", async () => {
  await expectCompleted(handoff, {
    dispatch: mock().mockResolvedValue(turnResult({ toolCalls: 1 })),
  });
});

test("guard: meta is absent", async () => {
  await expectCompleted(handoff, {
    dispatch: mock().mockResolvedValue(turnResult({ includeMeta: false })),
  });
});

test.each([
  ["false", handoffWith({ use_worktree: false })],
  ["omitted", handoffWithoutUseWorktree()],
] as const)("guard: use_worktree is %s", async (_label, fixture) => {
  await expectCompleted(fixture);
});

test("guard: a dirty changed worktree is completed", async () => {
  await expectCompleted(handoff, {
    getWorktreeSnapshot: mock().mockResolvedValue({
      worktreeChanged: true,
      dirty: true,
      committed: false,
    }),
  });
});

test("guard: a committed changed worktree is completed", async () => {
  await expectCompleted(handoff, {
    getWorktreeSnapshot: mock().mockResolvedValue({
      worktreeChanged: true,
      dirty: false,
      committed: true,
    }),
  });
});

test("guard: no getWorktreeSnapshot dep leaves the snapshot null", async () => {
  await expectCompleted(handoff, { getWorktreeSnapshot: undefined });
});

test("guard: max_hops with zero tool calls is not relabelled", async () => {
  const onChainEnd = mock();
  await expectCompleted(handoff, {
    onChainEnd,
    dispatch: mock().mockResolvedValue(turnResult({ toolCalls: 0, terminatedReason: "max_hops" })),
  });

  expect(chainEndReason(onChainEnd)).toBe("max_hops");
});

test("guard: smoke_test text-only root hop is completed", async () => {
  await expectCompleted(handoffWith({ chain_task_type: "smoke_test" }));
});

test.each(["health_check", "plan_refine"] as const)(
  "guard: %s text-only root hop is completed",
  async (chainTaskType) => {
    await expectCompleted(handoffWith({ chain_task_type: chainTaskType }));
  },
);

test("guard: a text-only final hop of a multi-hop chain is completed", async () => {
  await expectCompleted(handoffWith({ hop_idx: 1 }));
});
