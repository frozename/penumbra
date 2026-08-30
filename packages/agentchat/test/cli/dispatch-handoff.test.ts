import { expect, mock, test } from "bun:test";

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

test("hopsSoFar+1 >= maxHops → creates handoff but does not approve, returns max_hops", async () => {
  const runChatTurn = mock<ChatTurnMockFn>().mockResolvedValue({
    text: "go @executor",
    prompt_event_id: "p",
    response_event_id: "r1",
    next_mention: { target: "executor", resolution: { kind: "name", agent_name: "executor" } },
    mentions: [],
  });
  const createHandoff = mock().mockResolvedValue({ handoff_id: "h-cap", status: "pending" });
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

  expect(createHandoff).toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(res.terminatedReason).toBe("max_hops");
  expect(res.cappedHandoffId).toBe("h-cap");
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
