/**
 * Re-expressed parity for the legacy permission-boundary suite
 * (adapters/stdio-acp-permission.test.ts). The spawnCliAdapterStream half of
 * cli-spawn-stream.test.ts lives in cli-spawn-stream.parity.ts.
 *
 * The legacy suite drove StdioAcpAdapter end-to-end over a fake wire; the
 * permission behavior under test lives in the permission context + request
 * handler that was extracted. Each `[re-expressed]` test drives the packed
 * `StdioAcpPermissionContext` + `handleStdioAcpPermissionRequest` with the same
 * update/request frames and asserts the same observable outcome.
 *
 * Not re-expressed: "preserves the downstream terminal/create executor
 * contract after allow_once" — exercises only the non-extracted
 * StdioAcpAdapter executor.
 */
import { describe, expect, test } from "bun:test";

import {
  handleStdioAcpPermissionRequest,
  StdioAcpPermissionContext,
} from "../src/shim/stdio-acp-permission.js";

import type {
  AcpPermissionToolCallUpdate,
  PermissionDecideRequest,
  PermissionResult,
} from "penumbra-exec-primitives";

interface PermissionOption {
  kind: string;
  optionId: string;
}

const SESSION_ID = "session-1";
const DEFAULT_OPTIONS: PermissionOption[] = [
  { kind: "allow_always", optionId: "switch_bypass" },
  { kind: "allow_once", optionId: "allow_once" },
  { kind: "reject_once", optionId: "reject_once" },
];
const ALLOW_ONCE_RESULT: PermissionResult = {
  outcome: { outcome: "selected", optionId: "allow_once" },
};
const CANCELLED_RESULT: PermissionResult = { outcome: { outcome: "cancelled" } };
const COMPLETE_TOOL_CALL_UPDATE: AcpPermissionToolCallUpdate = {
  sessionUpdate: "tool_call",
  toolCallId: "tool-1",
  title: "terminal/create",
  input: { command: "bun test" },
};

interface ScenarioInit {
  decision?: "approve" | "reject";
  decide?: (req: PermissionDecideRequest) => "approve" | "reject" | Promise<"approve" | "reject">;
  options?: PermissionOption[] | unknown[];
  requestSessionId?: string;
  toolCall?: Record<string, unknown>;
  /** [sessionId, update] pairs — sessionId defaults to the active session. */
  updates?: [string | undefined, AcpPermissionToolCallUpdate][];
  /** Full wire-params override (e.g. null, malformed). */
  params?: unknown;
  signal?: AbortSignal;
  sessionId?: string;
}

interface ScenarioResult {
  result: PermissionResult;
  calls: PermissionDecideRequest[];
  decideCalled: boolean;
}

async function runPermissionScenario(scenario: ScenarioInit = {}): Promise<ScenarioResult> {
  const context = new StdioAcpPermissionContext();
  const sessionId = scenario.sessionId ?? SESSION_ID;
  context.activate(sessionId);
  for (const [updateSessionId, update] of scenario.updates ?? []) {
    context.observe(updateSessionId ?? sessionId, update);
  }
  const calls: PermissionDecideRequest[] = [];
  let decideCalled = false;
  const decide =
    scenario.decide ??
    ((req: PermissionDecideRequest): "approve" | "reject" => {
      calls.push(req);
      return scenario.decision ?? "approve";
    });
  const params =
    scenario.params !== undefined
      ? scenario.params
      : {
          sessionId: scenario.requestSessionId ?? sessionId,
          toolCall: scenario.toolCall ?? { toolCallId: "tool-1" },
          options: scenario.options ?? DEFAULT_OPTIONS,
        };
  const result = await handleStdioAcpPermissionRequest(
    {
      signal: scenario.signal ?? new AbortController().signal,
      dispatchId: "conversation-1",
      decide: (req) => {
        decideCalled = true;
        return decide(req);
      },
    },
    context,
    params,
  );
  return { result, calls, decideCalled };
}

describe("StdioAcpAdapter permission context (re-expressed)", () => {
  test("[re-expressed] recovers a protocol-shaped partial permission request from the matching tool call", async () => {
    const { result, calls } = await runPermissionScenario({
      updates: [
        [
          undefined,
          {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "terminal/create",
            input: { command: "bun test packages/agentchat/test/adapters/stdio-acp.test.ts" },
          },
        ],
      ],
      toolCall: { toolCallId: "tool-1" },
    });

    expect(calls).toEqual([
      {
        toolName: "terminal/create",
        rawInput: { command: "bun test packages/agentchat/test/adapters/stdio-acp.test.ts" },
        sessionId: "session-1",
      },
    ]);
    expect(result).toEqual(ALLOW_ONCE_RESULT);
  });

  test("[re-expressed] forwards a complete permission request without a prior tool-call update", async () => {
    const { result, calls } = await runPermissionScenario({
      toolCall: {
        toolCallId: "tool-1",
        title: "terminal/create",
        rawInput: { command: "bun test" },
      },
    });

    expect(calls).toEqual([
      {
        toolName: "terminal/create",
        rawInput: { command: "bun test" },
        sessionId: "session-1",
      },
    ]);
    expect(result).toEqual(ALLOW_ONCE_RESULT);
  });

  test("[re-expressed] selects the only non-bypass allow_once independently of option ordering", async () => {
    const options = [
      { kind: "allow_always", optionId: "switch_bypass" },
      { kind: "allow_always", optionId: "bypass" },
      { kind: "allow_always", optionId: "danger_bypass_mode" },
      { kind: "allow_always", optionId: "switch_accept_edits" },
      { kind: "reject_once", optionId: "reject_once" },
      { kind: "allow_once", optionId: "safe_once" },
    ];
    const { result } = await runPermissionScenario({
      options,
      updates: [[undefined, COMPLETE_TOOL_CALL_UPDATE]],
    });

    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "safe_once" } });
  });

  test("[re-expressed] selects reject_once on denial and never a persistent reject", async () => {
    const { result } = await runPermissionScenario({
      decision: "reject",
      options: [
        { kind: "reject_always", optionId: "reject_always" },
        { kind: "allow_once", optionId: "allow_once" },
        { kind: "reject_once", optionId: "reject_once" },
      ],
      updates: [[undefined, COMPLETE_TOOL_CALL_UPDATE]],
    });

    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
  });

  test("[re-expressed] cancels an approval when no safe allow_once option is offered", async () => {
    const { result, decideCalled } = await runPermissionScenario({
      options: [
        { kind: "allow_always", optionId: "switch_accept_edits" },
        { kind: "allow_once", optionId: "switch_bypass_once" },
        { kind: "reject_once", optionId: "reject_once" },
      ],
      updates: [[undefined, COMPLETE_TOOL_CALL_UPDATE]],
    });

    expect(decideCalled).toBe(true);
    expect(result).toEqual(CANCELLED_RESULT);
  });

  test("[re-expressed] merges partial updates while explicit request fields retain precedence", async () => {
    const { calls } = await runPermissionScenario({
      toolCall: { toolCallId: "tool-1", title: "explicit title", rawInput: null },
      updates: [
        [undefined, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "initial title" }],
        [
          undefined,
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            input: { command: "must not be borrowed" },
          },
        ],
      ],
    });

    expect(calls).toEqual([{ toolName: "explicit title", rawInput: null, sessionId: "session-1" }]);
  });

  test.each([
    ["missing", {}],
    ["unknown", { toolCallId: "unknown-tool" }],
  ])(
    "[re-expressed] does not borrow unrelated metadata for a %s tool-call id",
    async (_label, toolCall) => {
      const { result, decideCalled } = await runPermissionScenario({
        toolCall,
        updates: [
          [
            undefined,
            {
              sessionUpdate: "tool_call",
              toolCallId: "other-tool",
              title: "unrelated terminal",
              input: { command: "must not leak" },
            },
          ],
        ],
      });

      expect(decideCalled).toBe(false);
      expect(result).toEqual(CANCELLED_RESULT);
    },
  );

  test("[re-expressed] rejects a permission request from a different session", async () => {
    const { result, decideCalled } = await runPermissionScenario({
      requestSessionId: "session-2",
      updates: [
        [
          undefined,
          {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "terminal/create",
            input: { command: "bun test" },
          },
        ],
      ],
    });

    expect(decideCalled).toBe(false);
    expect(result).toEqual(CANCELLED_RESULT);
  });

  test("[re-expressed] does not retain tool metadata from a different session", async () => {
    const { result, decideCalled } = await runPermissionScenario({
      updates: [
        [
          "session-2",
          {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "unrelated terminal",
            input: { command: "must not leak" },
          },
        ],
      ],
    });

    expect(decideCalled).toBe(false);
    expect(result).toEqual(CANCELLED_RESULT);
  });

  test("[re-expressed] does not retain metadata from a non-tool session update", async () => {
    const { result, decideCalled } = await runPermissionScenario({
      updates: [
        [
          undefined,
          {
            sessionUpdate: "agent_message_chunk",
            toolCallId: "tool-1",
            title: "unrelated terminal",
            input: { command: "must not leak" },
          },
        ],
      ],
    });

    expect(decideCalled).toBe(false);
    expect(result).toEqual(CANCELLED_RESULT);
  });

  test("[re-expressed] recovers name and input from a prior tool_call_update", async () => {
    const { calls } = await runPermissionScenario({
      updates: [
        [
          undefined,
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            name: "terminal/create",
            input: { command: "bun test" },
          },
        ],
      ],
    });

    expect(calls).toEqual([
      { toolName: "terminal/create", rawInput: { command: "bun test" }, sessionId: "session-1" },
    ]);
  });

  test("[re-expressed] does not resurrect consumed context through an update or complete request", async () => {
    const context = new StdioAcpPermissionContext();
    context.activate(SESSION_ID);
    context.observe(SESSION_ID, COMPLETE_TOOL_CALL_UPDATE);
    const first = await handleStdioAcpPermissionRequest(
      {
        signal: new AbortController().signal,
        dispatchId: "conversation-1",
        decide: () => "approve",
      },
      context,
      { sessionId: SESSION_ID, toolCall: { toolCallId: "tool-1" }, options: DEFAULT_OPTIONS },
    );
    expect(first).toEqual(ALLOW_ONCE_RESULT);
    context.observe(SESSION_ID, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "terminal/create",
      input: { command: "bun test again" },
    });

    let decideCalls = 0;
    const repeated = await handleStdioAcpPermissionRequest(
      {
        signal: new AbortController().signal,
        dispatchId: "conversation-1",
        decide: () => {
          decideCalls += 1;
          return "approve";
        },
      },
      context,
      {
        sessionId: SESSION_ID,
        toolCall: {
          toolCallId: "tool-1",
          title: "terminal/create",
          rawInput: { command: "bun test again" },
        },
        options: DEFAULT_OPTIONS,
      },
    );

    expect(decideCalls).toBe(0);
    expect(repeated).toEqual(CANCELLED_RESULT);
  });

  test.each(["canceled", "cancelled", "completed", "failed"])(
    "[re-expressed] does not resurrect context after terminal status %s",
    async (status) => {
      const { result, decideCalled } = await runPermissionScenario({
        updates: [
          [undefined, COMPLETE_TOOL_CALL_UPDATE],
          [undefined, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status }],
          [
            undefined,
            {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-1",
              title: "terminal/create",
              input: { command: "bun test again" },
            },
          ],
        ],
      });

      expect(decideCalled).toBe(false);
      expect(result).toEqual(CANCELLED_RESULT);
    },
  );

  test.each(["terminal update", "session end", "dispatch abort"])(
    "[re-expressed] cancels a late approval after %s retires its context",
    async (retirement) => {
      const context = new StdioAcpPermissionContext();
      context.activate(SESSION_ID);
      const controller = new AbortController();
      context.observe(SESSION_ID, COMPLETE_TOOL_CALL_UPDATE);
      let resolveGate: ((decision: "approve") => void) | undefined;
      let markGateEntered: (() => void) | undefined;
      const gateEntered = new Promise<void>((resolve) => {
        markGateEntered = resolve;
      });
      const pending = handleStdioAcpPermissionRequest(
        {
          signal: controller.signal,
          dispatchId: "conversation-1",
          decide: () => {
            markGateEntered?.();
            return new Promise<"approve">((resolve) => {
              resolveGate = resolve;
            });
          },
        },
        context,
        {
          sessionId: SESSION_ID,
          toolCall: { toolCallId: "tool-1" },
          options: DEFAULT_OPTIONS,
        },
      );
      await gateEntered;
      if (retirement === "terminal update") {
        context.observe(SESSION_ID, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
        });
      } else if (retirement === "session end") {
        context.deactivate();
      } else {
        controller.abort();
      }
      resolveGate?.("approve");

      const result = await pending;
      expect(result).toEqual(CANCELLED_RESULT);
    },
  );

  test("[re-expressed] cancels before invoking the callback when the dispatch is already aborted", async () => {
    const context = new StdioAcpPermissionContext();
    context.activate(SESSION_ID);
    context.observe(SESSION_ID, COMPLETE_TOOL_CALL_UPDATE);
    const controller = new AbortController();
    controller.abort();

    let decideCalled = false;
    const result = await handleStdioAcpPermissionRequest(
      {
        signal: controller.signal,
        dispatchId: "conversation-1",
        decide: () => {
          decideCalled = true;
          return "approve";
        },
      },
      context,
      {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: "tool-1" },
        options: DEFAULT_OPTIONS,
      },
    );

    expect(decideCalled).toBe(false);
    expect(result).toEqual(CANCELLED_RESULT);
  });

  test("[re-expressed] cancels a denial when reject_once is absent", async () => {
    const { result } = await runPermissionScenario({
      decision: "reject",
      options: [
        { kind: "reject_always", optionId: "reject_always" },
        { kind: "allow_once", optionId: "allow_once" },
      ],
      updates: [[undefined, COMPLETE_TOOL_CALL_UPDATE]],
    });

    expect(result).toEqual(CANCELLED_RESULT);
  });

  test("[re-expressed] fails closed instead of throwing when permission options are malformed", async () => {
    const { result } = await runPermissionScenario({
      updates: [[undefined, COMPLETE_TOOL_CALL_UPDATE]],
      params: {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: "tool-1" },
        options: [null, { kind: "allow_always", optionId: "switch_bypass" }],
      },
    });

    expect(result).toEqual(CANCELLED_RESULT);
  });

  test("[re-expressed] fails closed when request_permission params are null", async () => {
    const { result, decideCalled } = await runPermissionScenario({ params: null });

    expect(decideCalled).toBe(false);
    expect(result).toEqual(CANCELLED_RESULT);
  });
});

describe("StdioAcpPermissionContext bounds (re-expressed)", () => {
  test("[re-expressed] activation clears context so a reused connection cannot borrow from the prior session", () => {
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

  test("[re-expressed] retirement tracking outlives the active-context limit and fails closed on overflow", () => {
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

  test("[re-expressed] evicts old entries and refuses oversized raw input", () => {
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

  test("[re-expressed] refuses oversized retained labels and tool-call ids", () => {
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
