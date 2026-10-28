import { expect, mock, test } from "bun:test";

import { registerAdapter } from "@src/adapters/registry.js";
import { dispatchHandoff } from "@src/cli/dispatch-handoff.js";
import type { ChatTurnInput, ChatTurnResult } from "@src/cli/loop.js";
import { PenumbraHttpError } from "@src/penumbra-client.js";
import type { WriteToolsExecutor } from "@src/worker/write-tools-executor.js";

type ChatTurnMockFn = (input: ChatTurnInput) => Promise<ChatTurnResult>;
type DelayMockFn = (ms: number) => Promise<void>;
type ObserveResult = { event_id: string };
const observeStub = (): Promise<ObserveResult> => Promise.resolve({ event_id: "e" });

const mockConv = { id: "c1", project_id: null };
const cfg = {
  agents: [
    {
      name: "planner",
      adapter: "a",
      options: {},
      roles: ["planner"],
      auto_approve_to: ["executor"],
    },
    { name: "executor", adapter: "a", options: {}, roles: ["executor"], auto_approve_to: [] },
  ],
  default_roles: {},
};
const baseHandoff = {
  handoff_id: "h0",
  ts: "t",
  project_id: null,
  conversation_id: "c1",
  from_agent: "user",
  to_agent: "planner",
  to_role: null,
  message: "hi",
  status: "approved",
  resolved_by: null,
  resolved_at: null,
  redirected_to: null,
  triggered_by_event_id: null,
  chain_max_hops: null,
  chain_trust_mode: null,
};

const stubExecutor = { id: "exec-stub" } as unknown as WriteToolsExecutor;

const AGY_QUOTA_MESSAGE =
  "/Users/x/.local/bin/agy: exit code 3 — error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 140h52m55s.\n" +
  'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true}\n';

test("chain-start handoff (from=user) sends raw message, no transcript wrap", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "done",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
  });

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });

  expect(res.terminatedReason).toBe("no_mention");
  expect(res.next).toBeNull();
  const call = runChatTurn.mock.calls[0]![0];
  expect(call.initialAgent).toBe("planner");
  expect(call.prompt).toBeUndefined(); // raw message via userMessage path
  expect(call.userMessage).toBe("hi");
});

test("continuation handoff wraps transcript via buildNextPrompt", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "ok",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
  });

  const continuation = {
    ...baseHandoff,
    handoff_id: "h1",
    from_agent: "planner",
    to_agent: "executor",
    message: "do the thing",
  };
  await dispatchHandoff({
    handoff: continuation,
    config: cfg,
    conversation: mockConv,
    transcript: [
      { agent: "user", text: "hi" },
      { agent: "planner", text: "do the thing" },
    ],
    transcriptBudget: 1000,
    hopsSoFar: 1,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });
  const call = runChatTurn.mock.calls[0]![0];
  expect(call.initialAgent).toBe("executor");
  expect(call.prompt).toContain("From @planner: do the thing");
  expect(call.prompt).toContain("[user]: hi");
});

test("mention triggers handoff create + approve when trustMode=all", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "ping @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
    mentions: [],
  });
  const createHandoff = mock().mockResolvedValue({ handoff_id: "h-next", status: "pending" });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve,
    runChatTurn,
  });

  expect(createHandoff).toHaveBeenCalledTimes(1);
  expect(createHandoff.mock.calls[0]![0]).toMatchObject({ from: "planner", to: "executor" });
  expect(approve).toHaveBeenCalledWith("h-next", { resolved_by: "auto" });
  expect(res.terminatedReason).toBeUndefined();
  expect(res.next?.handoff_id).toBe("h-next");
});

test("role mention continues to the routed agent returned by createHandoff", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "ping @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: {
      target: "executor",
      resolution: { kind: "role", agent_name: "executor", role: "executor" },
    },
    mentions: [],
  });
  const createHandoff = mock().mockResolvedValue({
    handoff_id: "h-routed",
    status: "pending",
    routed_agent: "codex-mini",
    routed_role: "executor",
    routing_task_type: "implement_small",
  });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve,
    runChatTurn,
  });

  expect(createHandoff.mock.calls[0]![0]).toMatchObject({
    to: "executor",
    to_role: "executor",
  });
  expect(res.next).toMatchObject({
    handoff_id: "h-routed",
    to: "codex-mini",
  });
});

test("unknown mention resolution terminates without creating a junk next handoff", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "Looks complete. @penumbra",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: { target: "penumbra", resolution: { kind: "unknown", target: "penumbra" } },
    mentions: [],
  });
  const createHandoff = mock();
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve,
    runChatTurn,
  });

  expect(createHandoff).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(res.next).toBeNull();
  expect(res.terminatedReason).toBe("no_mention");
  expect(res.text).toBe("Looks complete. @penumbra");
});

test("terminal createHandoff rejection uses a distinct handoff creation failure reason", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "ping @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
    mentions: [],
  });
  const createHandoff = mock().mockRejectedValue(
    new PenumbraHttpError("penumbra /handoffs: HTTP 400", 400, {
      error: { code: "unknown_agent" },
      field_errors: [{ path: ["to"], message: "unknown agent" }],
    }),
  );
  const approve = mock();
  const markFailed = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve,
    markFailed,
    runChatTurn,
  });

  expect(createHandoff).toHaveBeenCalledTimes(1);
  expect(approve).not.toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
  expect(res.next).toBeNull();
  expect(res.terminatedReason).toBe("handoff_creation_failed");
  expect(res.text).toBe("ping @executor");
  expect(res.terminalError).toEqual({
    status: 400,
    code: "unknown_agent",
    message: "penumbra /handoffs: HTTP 400 code=unknown_agent",
  });
});

test("retryable createHandoff rejection escapes dispatchHandoff", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "ping @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
    mentions: [],
  });
  const createHandoffError = new PenumbraHttpError("penumbra /handoffs: HTTP 500", 500, {
    error: { code: "internal_error" },
  });
  const createHandoff = mock().mockRejectedValue(createHandoffError);
  const approve = mock();

  let caught: unknown;
  try {
    await dispatchHandoff({
      handoff: baseHandoff,
      config: cfg,
      conversation: mockConv,
      transcript: [],
      transcriptBudget: 1000,
      hopsSoFar: 0,
      maxHops: 5,
      trustMode: "all",
      observe: observeStub,
      createHandoff,
      approve,
      runChatTurn,
    });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBe(createHandoffError);
  expect(approve).not.toHaveBeenCalled();
});

test("auth createHandoff rejection uses handoff creation failure and logs loudly", async () => {
  for (const status of [401, 403]) {
    const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
      text: "ping @executor",
      prompt_event_id: "p",
      response_event_id: "r1",
      next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
      mentions: [],
    });
    const createHandoff = mock().mockRejectedValue(
      new PenumbraHttpError(`penumbra /handoffs: HTTP ${String(status)}`, status, {
        error: { code: "auth_failed" },
      }),
    );
    const log = { error: mock() };
    const opts: Parameters<typeof dispatchHandoff>[0] & { log: typeof log } = {
      handoff: baseHandoff,
      config: cfg,
      conversation: mockConv,
      transcript: [],
      transcriptBudget: 1000,
      hopsSoFar: 0,
      maxHops: 5,
      trustMode: "all",
      observe: observeStub,
      createHandoff,
      approve: mock(),
      log,
      runChatTurn,
    };

    const res = await dispatchHandoff(opts);

    expect(res.terminatedReason).toBe("handoff_creation_failed");
    expect(res.terminalError).toEqual({
      status,
      code: "auth_failed",
      message: `penumbra /handoffs: HTTP ${String(status)} code=auth_failed`,
    });
    expect(log.error).toHaveBeenCalledTimes(1);
  }
});

test("continuation role mention forwards the existing chain task type", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "ping @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: {
      target: "executor",
      resolution: { kind: "role", agent_name: "executor", role: "executor" },
    },
    mentions: [],
  });
  const createHandoff = mock().mockResolvedValue({
    handoff_id: "h-routed",
    status: "pending",
  });

  await dispatchHandoff({
    handoff: { ...baseHandoff, chain_task_type: "implement_small" },
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve: mock(),
    runChatTurn,
  });

  expect(createHandoff.mock.calls[0]![0]).toMatchObject({
    chain_task_type: "implement_small",
  });
});

test("mention at hop cap returns max_hops without creating another handoff", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "go @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
    mentions: [],
  });
  const createHandoff = mock();
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 4,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve,
    runChatTurn,
  });

  expect(createHandoff).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(res.terminatedReason).toBe("max_hops");
  expect(res.next).toBeNull();
  expect(res.cappedHandoffId).toBeUndefined();
});

test("mention below hop cap passes parent id, branch base, and chain max hops", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "go @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
    mentions: [],
  });
  const createHandoff = mock().mockResolvedValue({ handoff_id: "h-next", status: "pending" });

  await dispatchHandoff({
    handoff: { ...baseHandoff, branch_base: "feat/round-one" },
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 3,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve: mock(),
    runChatTurn,
  });

  expect(createHandoff.mock.calls[0]![0]).toMatchObject({
    parent_handoff_id: "h0",
    branch_base: "feat/round-one",
    chain_max_hops: 5,
  });
});

test("mention with trustMode=config + edge in auto_approve_to → approves", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "ping @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
    mentions: [],
  });
  const createHandoff = mock().mockResolvedValue({ handoff_id: "h2", status: "pending" });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "config",
    observe: observeStub,
    createHandoff,
    approve,
    runChatTurn,
  });

  expect(approve).toHaveBeenCalled();
  expect(res.terminatedReason).toBeUndefined();
});

test("mention with trustMode=config + edge NOT in auto_approve_to → leaves pending, returns untrusted", async () => {
  const cfgNoTrust = {
    agents: [
      { name: "planner", adapter: "a", options: {}, roles: ["planner"], auto_approve_to: [] },
      { name: "executor", adapter: "a", options: {}, roles: ["executor"], auto_approve_to: [] },
    ],
    default_roles: {},
  };
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "ping @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
    mentions: [],
  });
  const createHandoff = mock().mockResolvedValue({ handoff_id: "h-untrusted", status: "pending" });
  const approve = mock();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfgNoTrust,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "config",
    observe: observeStub,
    createHandoff,
    approve,
    runChatTurn,
  });

  expect(createHandoff).toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(res.terminatedReason).toBe("untrusted");
  expect(res.next).toBeNull();
  expect(res.cappedHandoffId).toBe("h-untrusted");
});

test("runChatTurn error retries and eventually succeeds (no markFailed)", async () => {
  const runChatTurn = mock<ChatTurnMockFn>()
    .mockResolvedValueOnce({
      text: "",
      prompt_event_id: "p1",
      response_event_id: "r1",
      next_mention: null,
      mentions: [],
      error: { message: "adapter blew up" },
    })
    .mockResolvedValueOnce({
      text: "",
      prompt_event_id: "p2",
      response_event_id: "r2",
      next_mention: null,
      mentions: [],
      error: { message: "adapter blew up again" },
    })
    .mockResolvedValueOnce({
      text: "done",
      prompt_event_id: "p3",
      response_event_id: "r3",
      next_mention: null,
      mentions: [],
    });

  const createHandoff = mock();
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("no_mention");
  expect(res.next).toBeNull();
  expect(createHandoff).not.toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
  expect(runChatTurn).toHaveBeenCalledTimes(3);
  expect(delay.mock.calls.map((c) => c[0])).toEqual([200, 400]);
});

test("runChatTurn error exhausts retries → markFailed then throws", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
    error: { message: "adapter blew up" },
  });
  const createHandoff = mock();
  const markFailed = mock().mockResolvedValue({ handoff_id: "h0", status: "failed" });
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("error");
  expect(res.next).toBeNull();
  expect(res.cappedHandoffId).toBe("h0");
  expect(createHandoff).not.toHaveBeenCalled();
  expect(runChatTurn).toHaveBeenCalledTimes(4);
  expect(delay.mock.calls.map((c) => c[0])).toEqual([200, 400, 800]);
  expect(markFailed).toHaveBeenCalledTimes(1);
  expect(markFailed).toHaveBeenCalledWith("h0", "adapter blew up");
});

test("quota-exhausted turn error stops after one attempt (#298)", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
    error: { message: AGY_QUOTA_MESSAGE },
  });
  const createHandoff = mock();
  const markFailed = mock().mockResolvedValue({ handoff_id: "h0", status: "failed" });
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("error");
  expect(res.adapterError?.message).toBe(AGY_QUOTA_MESSAGE);
  expect(runChatTurn).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
  expect(markFailed).toHaveBeenCalledTimes(1);
  expect(markFailed).toHaveBeenCalledWith("h0", AGY_QUOTA_MESSAGE);
});

test("quota-exhausted thrown error stops after one attempt (#298)", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockRejectedValue(new Error(AGY_QUOTA_MESSAGE));
  const createHandoff = mock();
  const markFailed = mock().mockResolvedValue({ handoff_id: "h0", status: "failed" });
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("error");
  expect(runChatTurn).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
  expect(markFailed).toHaveBeenCalledWith("h0", AGY_QUOTA_MESSAGE);
});

test("a non-quota AGY_ERROR still retries four times (#298)", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
    error: { message: 'agy: exit code 3 — AGY_ERROR: {"status":"INTERNAL","error_code":500}' },
  });
  const createHandoff = mock();
  const markFailed = mock().mockResolvedValue({ handoff_id: "h0", status: "failed" });
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("error");
  expect(runChatTurn).toHaveBeenCalledTimes(4);
  expect(delay.mock.calls.map((c) => c[0])).toEqual([200, 400, 800]);
});

test("pre-aborted signal returns cancelled without calling runChatTurn", async () => {
  const controller = new AbortController();
  controller.abort();
  const runChatTurn = mock<ChatTurnMockFn>();
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    signal: controller.signal,
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("cancelled");
  expect(res.next).toBeNull();
  expect(runChatTurn).not.toHaveBeenCalled();
  expect(delay).not.toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
});

test("aborted failed returned turn stops without backoff or markFailed", async () => {
  const controller = new AbortController();
  const runChatTurn = mock<ChatTurnMockFn>().mockImplementation(() => {
    controller.abort();
    return Promise.resolve({
      text: "partial failure @executor",
      prompt_event_id: "p",
      response_event_id: "r",
      next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
      mentions: [],
      error: { message: "adapter aborted after cancel" },
    });
  });
  const createHandoff = mock();
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    signal: controller.signal,
    observe: observeStub,
    createHandoff,
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("cancelled");
  expect(res.next).toBeNull();
  expect(createHandoff).not.toHaveBeenCalled();
  expect(runChatTurn).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
});

test("thrown abort stops retry loop without markFailed", async () => {
  const controller = new AbortController();
  const runChatTurn = mock<ChatTurnMockFn>().mockImplementation(() => {
    controller.abort();
    return Promise.reject(new Error("adapter aborted"));
  });
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    signal: controller.signal,
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("cancelled");
  expect(res.next).toBeNull();
  expect(runChatTurn).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
});

test("abort during retry backoff prevents the next runChatTurn call", async () => {
  const controller = new AbortController();
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
    error: { message: "adapter failed before cancel" },
  });
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockImplementation(() => {
    controller.abort();
    return Promise.resolve();
  });

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    signal: controller.signal,
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("cancelled");
  expect(res.next).toBeNull();
  expect(runChatTurn).toHaveBeenCalledTimes(1);
  expect(delay.mock.calls.map((c) => c[0])).toEqual([200]);
  expect(markFailed).not.toHaveBeenCalled();
});

test("successful in-flight turn is honored when abort fires during it", async () => {
  const controller = new AbortController();
  const runChatTurn = mock<ChatTurnMockFn>().mockImplementation(() => {
    controller.abort();
    return Promise.resolve({
      text: "ping @executor",
      prompt_event_id: "p",
      response_event_id: "r1",
      next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
      mentions: [],
    });
  });
  const createHandoff = mock().mockResolvedValue({ handoff_id: "h-next", status: "pending" });
  const approve = mock();
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    signal: controller.signal,
    observe: observeStub,
    createHandoff,
    approve,
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBeUndefined();
  expect(res.next?.handoff_id).toBe("h-next");
  expect(createHandoff).toHaveBeenCalledTimes(1);
  expect(approve).toHaveBeenCalledWith("h-next", { resolved_by: "auto" });
  expect(delay).not.toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
});

test("non-aborted error text containing aborted still retries", async () => {
  const controller = new AbortController();
  const runChatTurn = mock<ChatTurnMockFn>()
    .mockResolvedValueOnce({
      text: "",
      prompt_event_id: "p1",
      response_event_id: "r1",
      next_mention: null,
      mentions: [],
      error: { message: "adapter said aborted but signal is still live" },
    })
    .mockResolvedValueOnce({
      text: "done",
      prompt_event_id: "p2",
      response_event_id: "r2",
      next_mention: null,
      mentions: [],
    });
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    signal: controller.signal,
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed: mock(),
    delay,
  });

  expect(res.terminatedReason).toBe("no_mention");
  expect(runChatTurn).toHaveBeenCalledTimes(2);
  expect(delay.mock.calls.map((c) => c[0])).toEqual([200]);
});

test("projectContext is threaded through to buildNextPrompt for continuation hops", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "ok",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
  });

  const continuation = {
    ...baseHandoff,
    handoff_id: "h1",
    from_agent: "planner",
    to_agent: "executor",
    message: "do",
  };
  await dispatchHandoff({
    handoff: continuation,
    config: cfg,
    conversation: mockConv,
    transcript: [{ agent: "user", text: "hi" }],
    transcriptBudget: 1000,
    hopsSoFar: 1,
    maxHops: 5,
    trustMode: "all",
    projectContext: "PROJECT-CTX-MARKER",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });
  expect(runChatTurn.mock.calls[0]![0].prompt).toContain("PROJECT-CTX-MARKER");
});

test("executor opt is forwarded to runChatTurn", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "done",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
  });

  await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    executor: stubExecutor,
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });

  expect(runChatTurn.mock.calls[0]![0].executor).toBe(stubExecutor);
});

test("abort signal is forwarded to runChatTurn", async () => {
  const controller = new AbortController();
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "done",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
  });

  await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    signal: controller.signal,
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });

  expect(runChatTurn.mock.calls[0]![0].signal).toBe(controller.signal);
});

const pendingEnvelope = { event_id: "pre-gen-1", event_type: "agent-response" };

function turnWithPending(text: string): ChatTurnResult {
  return {
    text,
    prompt_event_id: "p",
    response_event_id: "pre-gen-1",
    next_mention: null,
    mentions: [],
    pendingObservations: [pendingEnvelope],
  };
}

test("a turn carrying pendingObservations is not re-run and surfaces them on the result", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue(turnWithPending("done"));
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  // Mutation check: if pendingObservations surfaced through a throw were
  // treated as a failed turn, runChatTurn would be called 4 times.
  expect(runChatTurn).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
  expect(res.terminatedReason).toBe("no_mention");
  expect(res.text).toBe("done");
  expect(res.pendingObservations).toEqual([pendingEnvelope]);
});

test("a 400 from the agent-response observe runs the adapter exactly once (real runChatTurn)", async () => {
  let dispatches = 0;
  registerAdapter("mock-observe-400", () => ({
    kind: "mock-observe-400",
    dispatch({ prompt }: { prompt: string }): Promise<{ text: string }> {
      dispatches++;
      return Promise.resolve({ text: `echo: ${prompt}` });
    },
  }));
  const observeCfg = {
    agents: [{ name: "planner", adapter: "mock-observe-400", options: {}, roles: ["planner"] }],
    default_roles: {},
  };
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);
  const observedTypes: string[] = [];

  const res = await dispatchHandoff({
    handoff: { ...baseHandoff, handoff_id: "h-observe-400" },
    config: observeCfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: (event: Record<string, unknown>): Promise<ObserveResult> => {
      observedTypes.push(event.event_type as string);
      if (event.event_type === "agent-response") {
        return Promise.reject(
          new PenumbraHttpError("penumbra /observations: HTTP 400", 400, {
            error: { code: "validation_error" },
          }),
        );
      }
      return Promise.resolve({ event_id: "e" });
    },
    createHandoff: mock(),
    approve: mock(),
    markFailed,
    delay,
    // runChatTurn deliberately omitted — exercise the real turn runner.
  });

  expect(dispatches).toBe(1);
  expect(delay).not.toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
  expect(res.terminatedReason).toBe("no_mention");
  expect(res.text).toBe("echo: hi");
  expect(res.pendingObservations).toHaveLength(1);
  expect(res.pendingObservations![0]!.event_type).toBe("agent-response");
});

test("a TypeError from createHandoff after a finished turn still carries pendingObservations", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    ...turnWithPending("ping @executor"),
    next_mention: {
      target: "executor",
      resolution: { kind: "name", agent_name: "executor" },
    },
  });
  const createHandoff = mock().mockRejectedValue(new TypeError("socket closed"));

  let thrown: unknown;
  try {
    await dispatchHandoff({
      handoff: baseHandoff,
      config: cfg,
      conversation: mockConv,
      transcript: [],
      transcriptBudget: 1000,
      hopsSoFar: 0,
      maxHops: 5,
      trustMode: "all",
      observe: observeStub,
      createHandoff,
      approve: mock(),
      runChatTurn,
      delay: mock<DelayMockFn>().mockResolvedValue(undefined),
    });
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(TypeError);
  expect((thrown as { pendingObservations?: unknown[] }).pendingObservations).toEqual([
    pendingEnvelope,
  ]);
});

test("a TypeError from approve after a finished turn still carries pendingObservations", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    ...turnWithPending("ping @executor"),
    next_mention: {
      target: "executor",
      resolution: { kind: "name", agent_name: "executor" },
    },
  });
  const createHandoff = mock().mockResolvedValue({ handoff_id: "h-next", status: "pending" });
  const approve = mock().mockRejectedValue(new TypeError("socket closed"));

  let thrown: unknown;
  try {
    await dispatchHandoff({
      handoff: baseHandoff,
      config: cfg,
      conversation: mockConv,
      transcript: [],
      transcriptBudget: 1000,
      hopsSoFar: 0,
      maxHops: 5,
      trustMode: "all",
      observe: observeStub,
      createHandoff,
      approve,
      runChatTurn,
      delay: mock<DelayMockFn>().mockResolvedValue(undefined),
    });
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(TypeError);
  expect((thrown as { pendingObservations?: unknown[] }).pendingObservations).toEqual([
    pendingEnvelope,
  ]);
});

test("a successful next-hop result also carries pendingObservations", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    ...turnWithPending("ping @executor"),
    next_mention: {
      target: "executor",
      resolution: { kind: "name", agent_name: "executor" },
    },
  });
  const createHandoff = mock().mockResolvedValue({ handoff_id: "h-next", status: "pending" });
  const approve = mock().mockResolvedValue({ handoff_id: "h-next", status: "approved" });

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff,
    approve,
    runChatTurn,
    delay: mock<DelayMockFn>().mockResolvedValue(undefined),
  });

  expect(res.next?.handoff_id).toBe("h-next");
  expect(res.pendingObservations).toEqual([pendingEnvelope]);
});

test("markFailed rejecting on retry exhaustion resolves an error result with the adapter error", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
    error: { message: "adapter blew up" },
  });
  const markFailed = mock().mockRejectedValue(new TypeError("penumbra is not running"));
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  // Instead of throwing, the error result lets the dispatcher's durable
  // reporter own the terminal report.
  expect(res.terminatedReason).toBe("error");
  expect(res.cappedHandoffId).toBe("h0");
  expect(res.adapterError).toEqual({ message: "adapter blew up" });
  expect(runChatTurn).toHaveBeenCalledTimes(4);
  expect(markFailed).toHaveBeenCalledWith("h0", "adapter blew up");
});

test("a later transport error cannot overwrite the tracked adapter error", async () => {
  const runChatTurn = mock<ChatTurnMockFn>()
    .mockResolvedValueOnce({
      text: "",
      prompt_event_id: "p1",
      response_event_id: "r1",
      next_mention: null,
      mentions: [],
      error: { message: "adapter blew up" },
    })
    .mockRejectedValue(new TypeError("The socket connection was closed unexpectedly"));
  const markFailed = mock().mockResolvedValue({ handoff_id: "h0", status: "failed" });
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
  });

  expect(res.terminatedReason).toBe("error");
  expect(res.adapterError).toEqual({ message: "adapter blew up" });
  // markFailed reports the adapter error, not the later transport failure.
  expect(markFailed).toHaveBeenCalledWith("h0", "adapter blew up");
  expect(runChatTurn).toHaveBeenCalledTimes(4);
});

test("pendingObservations from an earlier failed turn survive onto the successful result", async () => {
  const runChatTurn = mock<ChatTurnMockFn>()
    .mockResolvedValueOnce({
      text: "",
      prompt_event_id: "p1",
      response_event_id: "r1",
      next_mention: null,
      mentions: [],
      error: { message: "adapter blew up" },
      pendingObservations: [pendingEnvelope],
    })
    .mockResolvedValueOnce({
      text: "done",
      prompt_event_id: "p2",
      response_event_id: "r2",
      next_mention: null,
      mentions: [],
    });
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    delay,
  });

  expect(res.terminatedReason).toBe("no_mention");
  expect(res.pendingObservations).toEqual([pendingEnvelope]);
});

test("handoff permission_profile is forwarded into the chat turn", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "done",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
  });

  await dispatchHandoff({
    handoff: { ...baseHandoff, permission_profile: "review_readonly" },
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
  });

  const call = runChatTurn.mock.calls[0]![0];
  expect(call.permission_profile).toBe("review_readonly");
});

const STALL_MESSAGE =
  "stdio-acp: no wire activity (session/update or onRequest) for 900000ms — agent stalled mid-turn";
type OnEventMockFn = NonNullable<Parameters<typeof dispatchHandoff>[0]["onEvent"]>;
type RecordedEvent = Parameters<OnEventMockFn>[0];

function failedTurn(message: string): ChatTurnResult {
  return {
    text: "",
    prompt_event_id: "p",
    response_event_id: "r",
    next_mention: null,
    mentions: [],
    error: { message },
  };
}

function okTurn(): ChatTurnResult {
  return {
    text: "done",
    prompt_event_id: "p2",
    response_event_id: "r2",
    next_mention: null,
    mentions: [],
  };
}

function turnRetries(onEvent: { mock: { calls: [RecordedEvent][] } }): RecordedEvent[] {
  return onEvent.mock.calls.map((c) => c[0]).filter((e) => e.kind === "agent.turn_retry");
}

test("a stalled turn records one agent.turn_retry before its backoff (#322)", async () => {
  const order: string[] = [];
  const runChatTurn = mock<ChatTurnMockFn>()
    .mockRejectedValueOnce(new Error(STALL_MESSAGE))
    .mockResolvedValueOnce(okTurn());
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockImplementation((ms) => {
    order.push(`delay:${String(ms)}`);
    return Promise.resolve();
  });
  const onEvent = mock<OnEventMockFn>().mockImplementation((event) => {
    order.push(`event:${event.kind}`);
  });

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
    eventContext: { handoffId: "h0", workerId: "w-1" },
    onEvent,
  });

  expect(res.terminatedReason).toBe("no_mention");
  expect(markFailed).not.toHaveBeenCalled();
  expect(runChatTurn).toHaveBeenCalledTimes(2);
  const retries = turnRetries(onEvent);
  expect(retries).toHaveLength(1);
  expect(retries[0]!.handoff_id).toBe("h0");
  expect(retries[0]!.worker_id).toBe("w-1");
  expect(retries[0]!.source).toBe("worker");
  expect(typeof retries[0]!.ts).toBe("string");
  expect(retries[0]!.meta).toEqual({
    attempt: 1,
    next_attempt: 2,
    backoff_ms: 200,
    error_class: "stall",
  });
  expect(JSON.stringify(retries[0])).not.toContain("no wire activity");
  expect(JSON.stringify(retries[0])).not.toContain("stalled");
  expect(order).toEqual(["event:agent.turn_retry", "delay:200"]);
});

test("every retry before exhaustion is recorded with its error class (#322)", async () => {
  const runChatTurn = mock<ChatTurnMockFn>()
    .mockResolvedValueOnce(failedTurn(STALL_MESSAGE))
    .mockResolvedValueOnce(failedTurn("stdio-acp-client: transport closed"))
    .mockResolvedValueOnce(failedTurn("adapter blew up"))
    .mockResolvedValueOnce(failedTurn("adapter blew up"));
  const markFailed = mock().mockResolvedValue({ handoff_id: "h0", status: "failed" });
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);
  const onEvent = mock<OnEventMockFn>();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
    eventContext: { handoffId: "h0", workerId: "w-1" },
    onEvent,
  });

  expect(res.terminatedReason).toBe("error");
  expect(runChatTurn).toHaveBeenCalledTimes(4);
  expect(markFailed).toHaveBeenCalledWith("h0", "adapter blew up");
  expect(turnRetries(onEvent).map((e) => e.meta)).toEqual([
    { attempt: 1, next_attempt: 2, backoff_ms: 200, error_class: "stall" },
    { attempt: 2, next_attempt: 3, backoff_ms: 400, error_class: "transport_closed" },
    { attempt: 3, next_attempt: 4, backoff_ms: 800, error_class: "error" },
  ]);
});

test("a quota failure records no agent.turn_retry (#322)", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockRejectedValue(new Error(AGY_QUOTA_MESSAGE));
  const markFailed = mock().mockResolvedValue({ handoff_id: "h0", status: "failed" });
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);
  const onEvent = mock<OnEventMockFn>();

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
    eventContext: { handoffId: "h0", workerId: "w-1" },
    onEvent,
  });

  expect(res.terminatedReason).toBe("error");
  expect(runChatTurn).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
  expect(turnRetries(onEvent)).toEqual([]);
});

test("no agent.turn_retry without a handoff id (#322)", async () => {
  const runChatTurn = mock<ChatTurnMockFn>()
    .mockRejectedValueOnce(new Error(STALL_MESSAGE))
    .mockResolvedValueOnce(okTurn());
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);
  const onEvent = mock<OnEventMockFn>();

  const res = await dispatchHandoff({
    handoff: { ...baseHandoff, handoff_id: undefined },
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    delay,
    onEvent,
  });

  expect(res.terminatedReason).toBe("no_mention");
  expect(runChatTurn).toHaveBeenCalledTimes(2);
  expect(onEvent).not.toHaveBeenCalled();
});

test("a throwing onEvent does not stop the retry (#322)", async () => {
  const runChatTurn = mock<ChatTurnMockFn>()
    .mockRejectedValueOnce(new Error(STALL_MESSAGE))
    .mockResolvedValueOnce(okTurn());
  const markFailed = mock();
  const delay = mock<DelayMockFn>().mockResolvedValue(undefined);
  const onEvent = mock<OnEventMockFn>().mockImplementation(() => {
    throw new Error("sink down");
  });

  const res = await dispatchHandoff({
    handoff: baseHandoff,
    config: cfg,
    conversation: mockConv,
    transcript: [],
    transcriptBudget: 1000,
    hopsSoFar: 0,
    maxHops: 5,
    trustMode: "all",
    observe: observeStub,
    createHandoff: mock(),
    approve: mock(),
    runChatTurn,
    markFailed,
    delay,
    eventContext: { handoffId: "h0", workerId: "w-1" },
    onEvent,
  });

  expect(res.terminatedReason).toBe("no_mention");
  expect(runChatTurn).toHaveBeenCalledTimes(2);
  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(markFailed).not.toHaveBeenCalled();
});
