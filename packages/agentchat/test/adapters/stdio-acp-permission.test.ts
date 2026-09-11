import { describe, expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";

import { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import { StdioAcpPermissionContext } from "@src/adapters/stdio-acp-permission.js";
import type { StdioAcpHandle } from "@src/adapters/stdio-acp-server.js";
import { StdioAcpAdapter } from "@src/adapters/stdio-acp.js";
import type { DispatchInput } from "@src/sdk/adapter.js";

interface JsonRpcMessage {
  id?: number;
  jsonrpc: "2.0";
  method?: string;
  params?: unknown;
  result?: unknown;
}

class FakeJsonRpcChild {
  readonly handle: StdioAcpHandle;
  private buffer = "";
  private readonly output: PassThrough;
  private readonly messages: JsonRpcMessage[] = [];
  private readonly waiters: {
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
  }[] = [];

  constructor() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    this.output = stdout;
    stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.drainLines();
    });
    this.handle = {
      stdin,
      stdout,
      exited: new Promise<number | null>(() => undefined),
      kill: vi.fn(),
      getStderrTail: (): string => "",
    };
  }

  send(message: JsonRpcMessage): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  next(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.messages.splice(index, 1);
      if (message === undefined) throw new Error("missing queued JSON-RPC message");
      return Promise.resolve(message);
    }
    return new Promise((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }

  private drainLines(): void {
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.accept(JSON.parse(line) as JsonRpcMessage);
      newline = this.buffer.indexOf("\n");
    }
  }

  private accept(message: JsonRpcMessage): void {
    const index = this.waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) {
      this.messages.push(message);
      return;
    }
    const [waiter] = this.waiters.splice(index, 1);
    if (waiter !== undefined) waiter.resolve(message);
  }
}

function makeInput(
  requestPermission: NonNullable<DispatchInput["requestPermission"]>,
  signal: AbortSignal = new AbortController().signal,
): DispatchInput {
  return {
    prompt: "run the focused test",
    conversation: { id: "conversation-1", project_id: null },
    config: {},
    signal,
    trust_mode: "config",
    requestPermission,
  };
}

interface PermissionOption {
  kind: string;
  optionId: string;
}

interface PermissionScenario {
  decision?: "approve" | "reject";
  options?: PermissionOption[];
  requestSessionId?: string;
  toolCall?: Record<string, unknown>;
  updates?: Record<string, unknown>[];
}

const DEFAULT_OPTIONS: PermissionOption[] = [
  { kind: "allow_always", optionId: "switch_bypass" },
  { kind: "allow_once", optionId: "allow_once" },
  { kind: "reject_once", optionId: "reject_once" },
];
const ALLOW_ONCE_RESULT = { outcome: { outcome: "selected", optionId: "allow_once" } };
const COMPLETE_TOOL_CALL_UPDATE = {
  sessionUpdate: "tool_call",
  toolCallId: "tool-1",
  title: "terminal/create",
  input: { command: "bun test" },
};

function sendUpdate(
  child: FakeJsonRpcChild,
  update: Record<string, unknown>,
  sessionId = "session-1",
): void {
  child.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

function sendPermissionRequest(
  child: FakeJsonRpcChild,
  toolCall: Record<string, unknown>,
  options: PermissionOption[],
  sessionId = "session-1",
  id = 77,
): void {
  child.send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: { sessionId, toolCall, options },
  });
}

async function runPermissionScenario(scenario: PermissionScenario = {}): Promise<{
  permissionResponse: JsonRpcMessage;
  requestPermission: ReturnType<typeof vi.fn<NonNullable<DispatchInput["requestPermission"]>>>;
}> {
  const child = new FakeJsonRpcChild();
  const requestPermission = vi.fn<NonNullable<DispatchInput["requestPermission"]>>(() =>
    Promise.resolve(scenario.decision ?? "approve"),
  );
  const { dispatch, promptId } = await beginDispatch(child, makeInput(requestPermission));
  for (const update of scenario.updates ?? []) sendUpdate(child, update);
  sendPermissionRequest(
    child,
    scenario.toolCall ?? { toolCallId: "tool-1" },
    scenario.options ?? DEFAULT_OPTIONS,
    scenario.requestSessionId,
  );
  const permissionResponse = await child.next((message) => message.id === 77);
  child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  await dispatch;
  return { permissionResponse, requestPermission };
}

async function beginDispatch(
  child: FakeJsonRpcChild,
  input: DispatchInput,
): Promise<{ dispatch: ReturnType<StdioAcpAdapter["dispatch"]>; promptId: number }> {
  const adapter = new StdioAcpAdapter(
    { binary: "fake-acp", terminal: true },
    {
      startServer: (): Promise<StdioAcpHandle> => Promise.resolve(child.handle),
      createClient: (handle): StdioAcpClient =>
        new StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout }),
    },
  );
  const dispatch = adapter.dispatch(input);
  const initialize = await child.next((message) => message.method === "initialize");
  child.send({ jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: 1 } });
  const sessionNew = await child.next((message) => message.method === "session/new");
  child.send({ jsonrpc: "2.0", id: sessionNew.id, result: { sessionId: "session-1" } });
  const prompt = await child.next((message) => message.method === "session/prompt");
  if (prompt.id === undefined) throw new Error("session/prompt did not include an id");
  return { dispatch, promptId: prompt.id };
}

// These frames are protocol-shaped minimal reproductions. The live trace did not
// retain the full tool-call payload, so they are not represented as exact captures.
describe("StdioAcpAdapter permission context", () => {
  test("recovers a protocol-shaped partial permission request from the matching tool call", async () => {
    const child = new FakeJsonRpcChild();
    const requestPermission = vi.fn<NonNullable<DispatchInput["requestPermission"]>>(() =>
      Promise.resolve("approve"),
    );
    const { dispatch, promptId } = await beginDispatch(child, makeInput(requestPermission));

    sendUpdate(child, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "terminal/create",
      input: { command: "bun test packages/agentchat/test/adapters/stdio-acp.test.ts" },
    });
    sendPermissionRequest(child, { toolCallId: "tool-1" }, DEFAULT_OPTIONS);

    const permissionResponse = await child.next((message) => message.id === 77);
    child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    await dispatch;

    expect(requestPermission).toHaveBeenCalledWith({
      toolName: "terminal/create",
      rawInput: { command: "bun test packages/agentchat/test/adapters/stdio-acp.test.ts" },
      dispatchId: "conversation-1",
    });
    expect(permissionResponse.result).toEqual(ALLOW_ONCE_RESULT);
  });

  test("forwards a complete permission request without a prior tool-call update", async () => {
    const result = await runPermissionScenario({
      toolCall: {
        toolCallId: "tool-1",
        title: "terminal/create",
        rawInput: { command: "bun test" },
      },
    });

    expect(result.requestPermission).toHaveBeenCalledWith({
      toolName: "terminal/create",
      rawInput: { command: "bun test" },
      dispatchId: "conversation-1",
    });
    expect(result.permissionResponse.result).toEqual(ALLOW_ONCE_RESULT);
  });

  test("preserves the downstream terminal/create executor contract after allow_once", async () => {
    const child = new FakeJsonRpcChild();
    const requestPermission = vi.fn<NonNullable<DispatchInput["requestPermission"]>>(() =>
      Promise.resolve("approve"),
    );
    const terminalCreate = vi.fn(() => Promise.resolve({ terminal_id: "terminal-1" }));
    const input = makeInput(requestPermission);
    input.executor = { terminalCreate } as unknown as NonNullable<DispatchInput["executor"]>;
    const { dispatch, promptId } = await beginDispatch(child, input);
    sendUpdate(child, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "terminal/create",
      input: { command: "bun test", args: ["bun", "test"], cwd: "." },
    });
    sendPermissionRequest(child, { toolCallId: "tool-1" }, DEFAULT_OPTIONS);
    await child.next((message) => message.id === 77);
    child.send({
      jsonrpc: "2.0",
      id: 78,
      method: "terminal/create",
      params: { command: "bun test", args: ["bun", "test"], cwd: "." },
    });

    const terminalResponse = await child.next((message) => message.id === 78);
    child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    await dispatch;

    expect(terminalCreate).toHaveBeenCalledWith(
      {
        command: "bun test",
        argv: ["bun", "test"],
        cwd: process.cwd(),
        output_byte_limit: undefined,
      },
      {
        toolName: "terminal.create",
        rawInput: { argv: ["bun", "test"], cmd: "bun test", cwd: process.cwd() },
        dispatchId: "unknown",
      },
    );
    expect(terminalResponse.result).toEqual({
      terminal_id: "terminal-1",
      terminalId: "terminal-1",
    });
  });

  test("selects the only non-bypass allow_once independently of option ordering", async () => {
    const options = [
      { kind: "allow_always", optionId: "switch_bypass" },
      { kind: "allow_always", optionId: "bypass" },
      { kind: "allow_always", optionId: "danger_bypass_mode" },
      { kind: "allow_always", optionId: "switch_accept_edits" },
      { kind: "reject_once", optionId: "reject_once" },
      { kind: "allow_once", optionId: "safe_once" },
    ];
    const result = await runPermissionScenario({
      options,
      updates: [COMPLETE_TOOL_CALL_UPDATE],
    });

    expect(result.permissionResponse.result).toEqual({
      outcome: { outcome: "selected", optionId: "safe_once" },
    });
  });

  test("selects reject_once on denial and never a persistent reject", async () => {
    const result = await runPermissionScenario({
      decision: "reject",
      options: [
        { kind: "reject_always", optionId: "reject_always" },
        { kind: "allow_once", optionId: "allow_once" },
        { kind: "reject_once", optionId: "reject_once" },
      ],
      updates: [COMPLETE_TOOL_CALL_UPDATE],
    });

    expect(result.permissionResponse.result).toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });
  });

  test("cancels an approval when no safe allow_once option is offered", async () => {
    const result = await runPermissionScenario({
      options: [
        { kind: "allow_always", optionId: "switch_accept_edits" },
        { kind: "allow_once", optionId: "switch_bypass_once" },
        { kind: "reject_once", optionId: "reject_once" },
      ],
      updates: [COMPLETE_TOOL_CALL_UPDATE],
    });

    expect(result.requestPermission).toHaveBeenCalledTimes(1);
    expect(result.permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("merges partial updates while explicit request fields retain precedence", async () => {
    const result = await runPermissionScenario({
      toolCall: { toolCallId: "tool-1", title: "explicit title", rawInput: null },
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "initial title" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          input: { command: "must not be borrowed" },
        },
      ],
    });

    expect(result.requestPermission).toHaveBeenCalledWith({
      toolName: "explicit title",
      rawInput: null,
      dispatchId: "conversation-1",
    });
  });

  test.each([
    ["missing", {}],
    ["unknown", { toolCallId: "unknown-tool" }],
  ])("does not borrow unrelated metadata for a %s tool-call id", async (_label, toolCall) => {
    const result = await runPermissionScenario({
      toolCall,
      updates: [
        {
          sessionUpdate: "tool_call",
          toolCallId: "other-tool",
          title: "unrelated terminal",
          input: { command: "must not leak" },
        },
      ],
    });

    expect(result.requestPermission).not.toHaveBeenCalled();
    expect(result.permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("rejects a permission request from a different session", async () => {
    const result = await runPermissionScenario({
      requestSessionId: "session-2",
      updates: [
        {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "terminal/create",
          input: { command: "bun test" },
        },
      ],
    });

    expect(result.requestPermission).not.toHaveBeenCalled();
    expect(result.permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("does not retain tool metadata from a different session", async () => {
    const child = new FakeJsonRpcChild();
    const requestPermission = vi.fn<NonNullable<DispatchInput["requestPermission"]>>(() =>
      Promise.resolve("approve"),
    );
    const { dispatch, promptId } = await beginDispatch(child, makeInput(requestPermission));
    sendUpdate(
      child,
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "unrelated terminal",
        input: { command: "must not leak" },
      },
      "session-2",
    );
    sendPermissionRequest(child, { toolCallId: "tool-1" }, DEFAULT_OPTIONS);

    const permissionResponse = await child.next((message) => message.id === 77);
    child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    await dispatch;

    expect(requestPermission).not.toHaveBeenCalled();
    expect(permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("does not retain metadata from a non-tool session update", async () => {
    const result = await runPermissionScenario({
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          toolCallId: "tool-1",
          title: "unrelated terminal",
          input: { command: "must not leak" },
        },
      ],
    });

    expect(result.requestPermission).not.toHaveBeenCalled();
    expect(result.permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("recovers name and input from a prior tool_call_update", async () => {
    const result = await runPermissionScenario({
      updates: [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          name: "terminal/create",
          input: { command: "bun test" },
        },
      ],
    });

    expect(result.requestPermission).toHaveBeenCalledWith({
      toolName: "terminal/create",
      rawInput: { command: "bun test" },
      dispatchId: "conversation-1",
    });
  });

  test("does not resurrect consumed context through an update or complete request", async () => {
    const child = new FakeJsonRpcChild();
    const requestPermission = vi.fn<NonNullable<DispatchInput["requestPermission"]>>(() =>
      Promise.resolve("approve"),
    );
    const { dispatch, promptId } = await beginDispatch(child, makeInput(requestPermission));
    sendUpdate(child, COMPLETE_TOOL_CALL_UPDATE);
    sendPermissionRequest(child, { toolCallId: "tool-1" }, DEFAULT_OPTIONS, "session-1", 77);
    await child.next((message) => message.id === 77);
    sendUpdate(child, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "terminal/create",
      input: { command: "bun test again" },
    });
    sendPermissionRequest(
      child,
      { toolCallId: "tool-1", title: "terminal/create", rawInput: { command: "bun test again" } },
      DEFAULT_OPTIONS,
      "session-1",
      78,
    );

    const repeatedResponse = await child.next((message) => message.id === 78);
    child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    await dispatch;

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(repeatedResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test.each(["canceled", "cancelled", "completed", "failed"])(
    "does not resurrect context after terminal status %s",
    async (status) => {
      const result = await runPermissionScenario({
        updates: [
          COMPLETE_TOOL_CALL_UPDATE,
          { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            title: "terminal/create",
            input: { command: "bun test again" },
          },
        ],
      });

      expect(result.requestPermission).not.toHaveBeenCalled();
      expect(result.permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
    },
  );

  test.each(["terminal update", "session end", "dispatch abort"])(
    "cancels a late approval after %s retires its context",
    async (retirement) => {
      const child = new FakeJsonRpcChild();
      const controller = new AbortController();
      let resolveGate: ((decision: "approve") => void) | undefined;
      let markGateEntered: (() => void) | undefined;
      const gateEntered = new Promise<void>((resolve) => {
        markGateEntered = resolve;
      });
      const requestPermission = vi.fn<NonNullable<DispatchInput["requestPermission"]>>(() => {
        markGateEntered?.();
        return new Promise<"approve">((resolve) => {
          resolveGate = resolve;
        });
      });
      const { dispatch, promptId } = await beginDispatch(
        child,
        makeInput(requestPermission, controller.signal),
      );
      sendUpdate(child, COMPLETE_TOOL_CALL_UPDATE);
      sendPermissionRequest(child, { toolCallId: "tool-1" }, DEFAULT_OPTIONS);
      await gateEntered;
      if (retirement === "terminal update") {
        sendUpdate(child, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
        });
      } else if (retirement === "session end") {
        child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        await dispatch;
      } else {
        controller.abort();
      }
      resolveGate?.("approve");

      const permissionResponse = await child.next((message) => message.id === 77);
      if (retirement !== "session end") {
        child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        await dispatch;
      }
      expect(permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
    },
  );

  test("cancels before invoking the callback when the dispatch is already aborted", async () => {
    const child = new FakeJsonRpcChild();
    const controller = new AbortController();
    const requestPermission = vi.fn<NonNullable<DispatchInput["requestPermission"]>>(() =>
      Promise.resolve("approve"),
    );
    const { dispatch, promptId } = await beginDispatch(
      child,
      makeInput(requestPermission, controller.signal),
    );
    sendUpdate(child, COMPLETE_TOOL_CALL_UPDATE);
    controller.abort();
    sendPermissionRequest(child, { toolCallId: "tool-1" }, DEFAULT_OPTIONS);

    const permissionResponse = await child.next((message) => message.id === 77);
    child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    await dispatch;

    expect(requestPermission).not.toHaveBeenCalled();
    expect(permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("cancels a denial when reject_once is absent", async () => {
    const result = await runPermissionScenario({
      decision: "reject",
      options: [
        { kind: "reject_always", optionId: "reject_always" },
        { kind: "allow_once", optionId: "allow_once" },
      ],
      updates: [COMPLETE_TOOL_CALL_UPDATE],
    });

    expect(result.permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("fails closed instead of throwing when permission options are malformed", async () => {
    const child = new FakeJsonRpcChild();
    const requestPermission = vi.fn<NonNullable<DispatchInput["requestPermission"]>>(() =>
      Promise.resolve("approve"),
    );
    const { dispatch, promptId } = await beginDispatch(child, makeInput(requestPermission));
    sendUpdate(child, COMPLETE_TOOL_CALL_UPDATE);
    child.send({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1" },
        options: [null, { kind: "allow_always", optionId: "switch_bypass" }],
      },
    });

    const permissionResponse = await child.next((message) => message.id === 77);
    child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    await dispatch;

    expect(permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("fails closed when request_permission params are null", async () => {
    const child = new FakeJsonRpcChild();
    const requestPermission = vi.fn<NonNullable<DispatchInput["requestPermission"]>>(() =>
      Promise.resolve("approve"),
    );
    const { dispatch, promptId } = await beginDispatch(child, makeInput(requestPermission));
    child.send({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: null,
    });

    const permissionResponse = await child.next((message) => message.id === 77);
    child.send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    await dispatch;

    expect(requestPermission).not.toHaveBeenCalled();
    expect(permissionResponse.result).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("StdioAcpPermissionContext bounds", () => {
  test("activation clears context so a reused connection cannot borrow from the prior session", () => {
    const context = new StdioAcpPermissionContext();
    context.activate("session-1");
    context.observe("session-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "terminal/create",
      input: { command: "bun test" },
    });
    context.observe("session-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "retired-tool",
      status: "completed",
    });
    context.activate("session-2");

    expect(
      context.resolve({ sessionId: "session-2", toolCall: { toolCallId: "tool-1" } }),
    ).toBeNull();
    expect(
      context.resolve({
        sessionId: "session-2",
        toolCall: { toolCallId: "retired-tool", title: "terminal/create", rawInput: null },
      }),
    ).not.toBeNull();
  });

  test("retirement tracking outlives the active-context limit and fails closed on overflow", () => {
    const context = new StdioAcpPermissionContext();
    context.activate("session-1");
    for (let index = 0; index < 4097; index += 1) {
      context.observe("session-1", {
        sessionUpdate: "tool_call_update",
        toolCallId: `retired-${String(index)}`,
        status: "completed",
      });
    }
    expect(
      context.resolve({
        sessionId: "session-1",
        toolCall: { toolCallId: "new-tool", title: "terminal/create", rawInput: null },
      }),
    ).toBeNull();
  });

  test("evicts old entries and refuses oversized raw input", () => {
    const context = new StdioAcpPermissionContext();
    context.activate("session-1");
    for (let index = 0; index < 65; index += 1) {
      context.observe("session-1", {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${String(index)}`,
        title: "terminal/create",
        input: { index },
      });
    }
    context.observe("session-1", {
      sessionUpdate: "tool_call",
      toolCallId: "oversized",
      title: "terminal/create",
      input: "x".repeat(65 * 1024),
    });

    expect(
      context.resolve({ sessionId: "session-1", toolCall: { toolCallId: "tool-0" } }),
    ).toBeNull();
    expect(
      context.resolve({ sessionId: "session-1", toolCall: { toolCallId: "oversized" } }),
    ).toBeNull();
  });

  test("refuses oversized retained labels and tool-call ids", () => {
    const context = new StdioAcpPermissionContext();
    const oversized = "x".repeat(1025);
    context.activate("session-1");
    context.observe("session-1", {
      sessionUpdate: "tool_call",
      toolCallId: "oversized-title",
      title: oversized,
      input: { command: "bun test" },
    });
    context.observe("session-1", {
      sessionUpdate: "tool_call",
      toolCallId: oversized,
      title: "terminal/create",
      input: { command: "bun test" },
    });

    expect(
      context.resolve({ sessionId: "session-1", toolCall: { toolCallId: "oversized-title" } }),
    ).toBeNull();
    expect(
      context.resolve({ sessionId: "session-1", toolCall: { toolCallId: oversized } }),
    ).toBeNull();
  });
});
