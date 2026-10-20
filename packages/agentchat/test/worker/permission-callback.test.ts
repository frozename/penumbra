import { describe, expect, it } from "bun:test";

import type { PermissionCallbackV2Opts } from "@src/worker/permission-callback.js";
import { createPermissionCallback } from "@src/worker/permission-callback.js";
import type {
  PermissionDecisionResult,
  RequestPermissionInput,
} from "@src/worker/permission-daemon-client.js";

type DaemonClientStub = PermissionCallbackV2Opts["daemonClient"];

function makeDaemon(
  fn: (input: RequestPermissionInput) => Promise<PermissionDecisionResult>,
): DaemonClientStub {
  return { requestPermission: fn };
}

describe("createPermissionCallback", () => {
  it("returns 'approve' for trust_mode='all'", async () => {
    const cb = createPermissionCallback("all");
    const decision = await cb({ toolName: "fs.readTextFile", rawInput: {}, dispatchId: "test" });
    expect(decision).toBe("approve");
  });

  it("returns 'reject' for trust_mode='config'", async () => {
    const cb = createPermissionCallback("config");
    const decision = await cb({ toolName: "fs.readTextFile", rawInput: {}, dispatchId: "test" });
    expect(decision).toBe("reject");
  });

  it("defaults to approve when trust mode is omitted", async () => {
    const cb = createPermissionCallback();
    const decision = await cb({
      toolName: "mcp__penumbra__chain.list_agents",
      rawInput: null,
      dispatchId: "test",
    });
    expect(decision).toBe("approve");
  });
});

describe("createPermissionCallback (v2 form, with allowlist + daemon)", () => {
  function makeFakeDaemon(
    decision: "approve" | "reject",
    remember: "this_call" | "this_dispatch" | null = null,
  ): DaemonClientStub {
    return makeDaemon((): Promise<PermissionDecisionResult> => {
      return Promise.resolve({ decision, remember, reason: null });
    });
  }

  it("v2: trustMode='all' short-circuits to approve without daemon round-trip", async () => {
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: "all",
      allowedTools: [],
      handoffId: "h-1",
      conversationId: "c-1",
      agentName: "claude-acp-sonnet",
      ttlSeconds: 300,
      daemonClient: makeDaemon((): Promise<PermissionDecisionResult> => {
        calls.push("called");
        return Promise.resolve({ decision: "reject", remember: null, reason: null });
      }),
      perDispatchAllowlist: new Set<string>(),
    });
    expect(await cb({ toolName: "fs.readTextFile", rawInput: {}, dispatchId: "test" })).toBe(
      "approve",
    );
    expect(calls).toEqual([]);
  });

  it("v2: allowlist match short-circuits to approve under 'config'", async () => {
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: "config",
      allowedTools: ["mcp__penumbra__*"],
      handoffId: "h-1",
      conversationId: "c",
      agentName: "a",
      ttlSeconds: 300,
      daemonClient: makeDaemon((): Promise<PermissionDecisionResult> => {
        calls.push("called");
        return Promise.resolve({ decision: "reject", remember: null, reason: null });
      }),
      perDispatchAllowlist: new Set<string>(),
    });
    expect(
      await cb({ toolName: "mcp__penumbra__chain.list_agents", rawInput: {}, dispatchId: "test" }),
    ).toBe("approve");
    expect(calls).toEqual([]);
  });

  it("v2: off-list under 'config' calls daemon and returns its decision", async () => {
    const cb = createPermissionCallback({
      trustMode: "config",
      allowedTools: ["mcp__penumbra__*"],
      handoffId: "h-1",
      conversationId: "c",
      agentName: "a",
      ttlSeconds: 300,
      daemonClient: makeFakeDaemon("approve"),
      perDispatchAllowlist: new Set<string>(),
    });
    expect(
      await cb({ toolName: "mcp__sirius__chat", rawInput: { msg: "hi" }, dispatchId: "test" }),
    ).toBe("approve");
  });

  it("v2: 'this_dispatch' remember adds tool to per-dispatch cache; second call short-circuits", async () => {
    const perDispatch = new Set<string>();
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: "config",
      allowedTools: [],
      handoffId: "h-1",
      conversationId: "c",
      agentName: "a",
      ttlSeconds: 300,
      daemonClient: makeDaemon(
        (input: RequestPermissionInput): Promise<PermissionDecisionResult> => {
          calls.push(input.tool_name);
          return Promise.resolve({
            decision: "approve",
            remember: "this_dispatch",
            reason: null,
          });
        },
      ),
      perDispatchAllowlist: perDispatch,
    });
    expect(await cb({ toolName: "fs.readTextFile", rawInput: {}, dispatchId: "test" })).toBe(
      "approve",
    );
    expect(calls).toEqual(["fs.readTextFile"]);
    expect(perDispatch.has("fs.readTextFile")).toBe(true);
    // Second call to the same tool should NOT round-trip the daemon.
    expect(await cb({ toolName: "fs.readTextFile", rawInput: {}, dispatchId: "test" })).toBe(
      "approve",
    );
    expect(calls).toEqual(["fs.readTextFile"]); // still only one call
  });

  it("v2: daemon Promise rejection ⇒ 'reject' (fail closed)", async () => {
    const cb = createPermissionCallback({
      trustMode: "config",
      allowedTools: [],
      handoffId: "h-1",
      conversationId: "c",
      agentName: "a",
      ttlSeconds: 300,
      daemonClient: makeDaemon((): Promise<PermissionDecisionResult> => {
        return Promise.reject(new Error("expired"));
      }),
      perDispatchAllowlist: new Set<string>(),
    });
    expect(await cb({ toolName: "fs.readTextFile", rawInput: {}, dispatchId: "test" })).toBe(
      "reject",
    );
  });

  it("v2: 'this_call' remember does NOT populate per-dispatch cache", async () => {
    const perDispatch = new Set<string>();
    const calls: string[] = [];
    const cb = createPermissionCallback({
      trustMode: "config",
      allowedTools: [],
      handoffId: "h-1",
      conversationId: "c",
      agentName: "a",
      ttlSeconds: 300,
      daemonClient: makeDaemon(
        (input: RequestPermissionInput): Promise<PermissionDecisionResult> => {
          calls.push(input.tool_name);
          return Promise.resolve({ decision: "approve", remember: "this_call", reason: null });
        },
      ),
      perDispatchAllowlist: perDispatch,
    });
    expect(await cb({ toolName: "fs.readTextFile", rawInput: {}, dispatchId: "test" })).toBe(
      "approve",
    );
    expect(perDispatch.has("fs.readTextFile")).toBe(false);
    // Second call must round-trip the daemon (cache wasn't populated)
    expect(await cb({ toolName: "fs.readTextFile", rawInput: {}, dispatchId: "test" })).toBe(
      "approve",
    );
    expect(calls.length).toBe(2);
  });

  it("v2: daemon-returned 'reject' (operator denied) maps to 'reject'", async () => {
    const cb = createPermissionCallback({
      trustMode: "config",
      allowedTools: [],
      handoffId: "h-1",
      conversationId: "c",
      agentName: "a",
      ttlSeconds: 300,
      daemonClient: makeDaemon((): Promise<PermissionDecisionResult> => {
        return Promise.resolve({
          decision: "reject",
          remember: null,
          reason: "operator denied",
        });
      }),
      perDispatchAllowlist: new Set<string>(),
    });
    expect(await cb({ toolName: "mcp__sirius__chat", rawInput: {}, dispatchId: "test" })).toBe(
      "reject",
    );
  });
});

describe("createPermissionCallback (permission_profile gate)", () => {
  function profiledCallback(overrides?: Partial<PermissionCallbackV2Opts>): {
    cb: ReturnType<typeof createPermissionCallback>;
    calls: RequestPermissionInput[];
  } {
    const calls: RequestPermissionInput[] = [];
    const cb = createPermissionCallback({
      trustMode: "all",
      allowedTools: [],
      handoffId: "h-profile",
      conversationId: "c-profile",
      agentName: "reviewer",
      ttlSeconds: 300,
      daemonClient: makeDaemon((input) => {
        calls.push(input);
        return Promise.resolve({ decision: "approve", remember: null, reason: null });
      }),
      perDispatchAllowlist: new Set<string>(),
      permissionProfile: "review_readonly",
      ...overrides,
    });
    return { cb, calls };
  }

  it("denies file writes even under trust_mode='all'", async () => {
    const { cb, calls } = profiledCallback();
    for (const toolName of [
      "fs.write_text_file",
      "fs.write",
      "fs.edit",
      "write_file",
      "apply_patch",
    ]) {
      expect(await cb({ toolName, rawInput: { path: "a.ts" }, dispatchId: "d" })).toBe("reject");
    }
    expect(calls).toEqual([]);
  });

  it("denies mutating shell commands and allows read-only ones", async () => {
    const { cb } = profiledCallback();
    expect(
      await cb({
        toolName: "terminal.create",
        rawInput: { command: "git commit -m x" },
        dispatchId: "d",
      }),
    ).toBe("reject");
    expect(
      await cb({
        toolName: "terminal.create",
        rawInput: { command: "git status --short" },
        dispatchId: "d",
      }),
    ).toBe("approve");
  });

  it("denies uninspectable command inputs fail-closed", async () => {
    const { cb } = profiledCallback();
    expect(await cb({ toolName: "terminal.create", rawInput: 42, dispatchId: "d" })).toBe("reject");
  });

  it("still approves non-write tools and read-only MCP calls", async () => {
    const { cb } = profiledCallback();
    expect(await cb({ toolName: "fs.read_text_file", rawInput: {}, dispatchId: "d" })).toBe(
      "approve",
    );
    expect(
      await cb({
        toolName: "mcp__penumbra__memory.search",
        rawInput: {},
        dispatchId: "d",
      }),
    ).toBe("approve");
  });

  it("byte-identical behavior when permissionProfile is omitted", async () => {
    const cb = createPermissionCallback({
      trustMode: "all",
      allowedTools: [],
      handoffId: "h",
      conversationId: "c",
      agentName: "a",
      ttlSeconds: 300,
      daemonClient: makeDaemon(() =>
        Promise.resolve({ decision: "reject", remember: null, reason: null }),
      ),
      perDispatchAllowlist: new Set<string>(),
    });
    expect(await cb({ toolName: "fs.write_text_file", rawInput: {}, dispatchId: "d" })).toBe(
      "approve",
    );
  });
});
