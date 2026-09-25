import { describe, expect, test } from "bun:test";
import { StdioAcpPermissionContext } from "penumbra-exec-primitives";

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
