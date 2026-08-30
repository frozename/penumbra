import { ChainStartRequestSchema } from "@penumbra/core";
import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import {
  CallerCwdNotRegisteredError,
  chainStartHandler,
  ChainStartInputShape,
  ProjectIdRequiredError,
  RegistryUnavailableError,
} from "@src/tools/chain-start.js";

import { fakeDaemon } from "../helpers.js";

type StartChainFn = DaemonClient["startChain"];
type StartChainBody = Parameters<StartChainFn>[0];
type StartChainResult = Awaited<ReturnType<StartChainFn>>;
type ErrorConstructor = new (...args: never[]) => Error;

// bun:test types report `.rejects.toThrow(...)` / `.rejects.toBeInstanceOf(...)`
// as returning `void`, but each is async at runtime. Avoid the chain entirely so
// no-confusing-void-expression and await-thenable have nothing to flag.
async function expectRejectsWith(
  promise: Promise<unknown>,
  matcher: RegExp | string | ErrorConstructor,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (matcher instanceof RegExp) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(matcher);
      return;
    }
    if (typeof matcher === "string") {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(matcher);
      return;
    }
    expect(err).toBeInstanceOf(matcher);
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

const DEFAULT_RESULT: StartChainResult = {
  conversation_id: "conv-1",
  handoff_id: "h-1",
};

function makeStartChain(result: StartChainResult = DEFAULT_RESULT): {
  daemon: DaemonClient;
  startChain: StartChainFn;
} {
  const startChain = mock<StartChainFn>(() => Promise.resolve(result));
  return { daemon: fakeDaemon({ startChain }), startChain };
}

function calls(startChain: StartChainFn): StartChainBody[] {
  // The bun:test `mock<T>(fn)` overload returns the original function signature,
  // not the `T & { mock: ... }` shape the runtime carries. Read recorded calls
  // through a typed shim instead of widening with `any`.
  return (startChain as unknown as { mock: { calls: [StartChainBody][] } }).mock.calls.map(
    (entry) => entry[0],
  );
}

test("ChainStartInputShape requires initial_agent and message", () => {
  expect(() => ChainStartInputShape.initial_agent.parse(undefined)).toThrow();
});

test("ChainStartInputShape requires task_class", () => {
  expect(() => ChainStartInputShape.task_class.parse(undefined)).toThrow();
});

test("ChainStartInputShape exposes the canonical dispatch_kind enum", () => {
  expect(ChainStartInputShape.dispatch_kind.unwrap().options).toEqual(
    ChainStartRequestSchema.shape.dispatch_kind.unwrap().options,
  );
});

test("ChainStartInputShape exposes the canonical boolean tool_free hint", () => {
  const mcpToolFreeSchema = ChainStartInputShape.tool_free;
  const canonicalToolFreeSchema = ChainStartRequestSchema.shape.tool_free;

  for (const value of [true, false] as const) {
    expect(mcpToolFreeSchema.parse(value)).toBe(canonicalToolFreeSchema.parse(value));
  }
  expect(mcpToolFreeSchema.safeParse("true").success).toBe(false);
});

test("chain.start handler forwards tool_free to daemon.startChain", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);

  await handler({ initial_agent: "executor", message: "summarize", tool_free: true });

  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "summarize",
    tool_free: true,
  });
});

test("chain.start handler forwards explicit false tool_free to daemon.startChain", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);

  await handler({ initial_agent: "executor", message: "summarize", tool_free: false });

  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "summarize",
    tool_free: false,
  });
});

test("chain.start handler omits absent tool_free from daemon.startChain", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);

  await handler({ initial_agent: "executor", message: "summarize" });

  const recorded = calls(startChain);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toEqual({
    initial_agent: "executor",
    message: "summarize",
  });
  expect(Object.prototype.hasOwnProperty.call(recorded[0], "tool_free")).toBe(false);
});

test.each(["BOUNDARY", "STANDARD", "TRIVIAL"] as const)(
  "chain.start handler forwards task_class=%s to daemon.startChain",
  async (task_class) => {
    const { daemon, startChain } = makeStartChain();
    const handler = chainStartHandler(daemon);

    await handler({ initial_agent: "planner", message: "hi", task_class });

    expect(startChain).toHaveBeenCalledWith({
      initial_agent: "planner",
      message: "hi",
      task_class,
    });
  },
);

test("chain.start handler proxies to daemon.startChain and returns conversation_id + handoff_id", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);
  const res = await handler({
    initial_agent: "planner",
    message: "hi",
    max_hops: 5,
    trust_mode: "all",
  });
  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "planner",
    message: "hi",
    max_hops: 5,
    trust_mode: "all",
  });
  expect(res.content[0].type).toBe("text");
  expect(res.content[0].text).toMatch(/^◌ chain_start {2}/);
  expect(res.content[0].text).toContain('"conversation_id": "conv-1"');
  expect(res.content[0].text).toContain('"handoff_id": "h-1"');
});

test("chain.start handler forwards task_type hints for routing", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);
  await handler({ initial_agent: "executor", message: "hi", task_type: "implement_substantial" });
  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "hi",
    task_type: "implement_substantial",
  });
});

test("chain.start handler forwards branch_base when supplied", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);
  await handler({ initial_agent: "executor", message: "hi", branch_base: "agent/h-2" });
  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "hi",
    branch_base: "agent/h-2",
  });
});

test("chain.start handler forwards branch naming hints when supplied", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);
  await handler({
    initial_agent: "executor",
    message: "hi",
    task_name: "Full task pool",
    branch_type: "feat",
  });
  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "hi",
    task_name: "Full task pool",
    branch_type: "feat",
  });
});

test("chain.start handler forwards open_pr_on_review when supplied", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);
  await handler({ initial_agent: "executor", message: "hi", open_pr_on_review: true });
  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "hi",
    open_pr_on_review: true,
  });
});

test("chain.start handler forwards long-lived dispatch identity fields when supplied", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);
  await handler({
    initial_agent: "executor",
    message: "hi",
    dispatch_kind: "long_lived_tick",
    long_lived_agent_id: "agent-1",
    long_lived_tick_id: "tick-1",
  });
  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "executor",
    message: "hi",
    dispatch_kind: "long_lived_tick",
    long_lived_agent_id: "agent-1",
    long_lived_tick_id: "tick-1",
  });
});

test("chain.start auto-resolves project_id from cwd when caller omits it", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    await handler({ initial_agent: "planner", message: "hi" });

    expect(startChain).toHaveBeenCalledWith(
      expect.objectContaining({
        initial_agent: "planner",
        message: "hi",
        project_id: "llamactl",
      }),
    );
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
});

test("chain.start throws cwd_not_registered when no project_id and cwd resolver returns undefined", async () => {
  const { daemon, startChain } = makeStartChain();
  const resolver = mock<() => string | undefined>(() => undefined);
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await expectRejectsWith(
    handler({ initial_agent: "planner", message: "hi", use_worktree: true }),
    /cwd_not_registered/,
  );
  expect(startChain).not.toHaveBeenCalled();
});

test("chain.start does not throw cwd_not_registered when use_worktree is false and resolver returns undefined", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  const resolver = mock<() => string | undefined>(() => undefined);
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    await handler({ initial_agent: "planner", message: "hi", use_worktree: false });

    expect(startChain).toHaveBeenCalledWith(
      expect.objectContaining({
        initial_agent: "planner",
        message: "hi",
        use_worktree: false,
      }),
    );
    const recorded = calls(startChain);
    expect(recorded[0]?.project_id).toBeUndefined();
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
});

test("chain.start requires project_id even when use_worktree is false and explicit project_id is omitted", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    await expectRejectsWith(
      handler({ initial_agent: "planner", message: "hi", use_worktree: false }),
      ProjectIdRequiredError,
    );
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
  expect(startChain).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledTimes(1);
});

test("chain.start requires explicit project_id when env-gate is set and project_id is null", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    await expectRejectsWith(
      handler({ initial_agent: "planner", message: "hi", project_id: null }),
      ProjectIdRequiredError,
    );
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
  expect(startChain).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledTimes(1);
});

test("chain.start long-lived tick exemption bypasses explicit project_id gate and leaves project_id unset", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    const res = await handler({
      initial_agent: "planner",
      message: "hi",
      dispatch_kind: "long_lived_tick",
      long_lived_agent_id: "agent-1",
      long_lived_tick_id: "tick-1",
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(startChain).toHaveBeenCalledWith(
      expect.objectContaining({
        initial_agent: "planner",
        message: "hi",
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "agent-1",
        long_lived_tick_id: "tick-1",
      }),
    );
    const recorded = calls(startChain);
    expect(recorded[0]?.project_id).toBeUndefined();
    expect(res).not.toHaveProperty("resolution_warning");
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
});

test("chain.start workflow exemption bypasses explicit project_id gate and leaves project_id unset", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    const res = await handler({
      initial_agent: "planner",
      message: "hi",
      dispatch_kind: "workflow",
      workflow_run_id: "wf-1",
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(startChain).toHaveBeenCalledWith(
      expect.objectContaining({
        initial_agent: "planner",
        message: "hi",
        dispatch_kind: "workflow",
        workflow_run_id: "wf-1",
      }),
    );
    const recorded = calls(startChain);
    expect(recorded[0]?.project_id).toBeUndefined();
    expect(res).not.toHaveProperty("resolution_warning");
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
});

test("chain.start malformed long-lived tick envelope still requires explicit project_id under env-gate", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    await expectRejectsWith(
      handler({
        initial_agent: "planner",
        message: "hi",
        dispatch_kind: "long_lived_tick",
        long_lived_agent_id: "agent-1",
      }),
      ProjectIdRequiredError,
    );
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
  expect(startChain).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledTimes(1);
});

test("chain.start requires explicit project_id when env-gate is set and no dispatch_kind is supplied", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    await expectRejectsWith(
      handler({ initial_agent: "planner", message: "hi" }),
      ProjectIdRequiredError,
    );
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
  expect(startChain).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledTimes(1);
});

test("chain.start does not auto-resolve when caller passes explicit project_id", async () => {
  const { daemon, startChain } = makeStartChain();
  const resolver = mock<() => string | undefined>(() => "would-be-wrong");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await handler({ initial_agent: "planner", message: "hi", project_id: "sirius" });

  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "sirius",
    }),
  );
  expect(resolver).not.toHaveBeenCalled();
});

test("chain.start does not auto-resolve when caller explicitly passes project_id: null", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    await handler({ initial_agent: "planner", message: "hi", project_id: null });

    expect(resolver).not.toHaveBeenCalled();
    const recorded = calls(startChain);
    expect(recorded[0]?.project_id).toBeUndefined();
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
});

test("chain.start resolves caller_cwd when project_id is null", async () => {
  const { daemon, startChain } = makeStartChain();
  const pathResolver = mock<(path: string) => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromPath: pathResolver });

  const res = await handler({
    initial_agent: "planner",
    message: "hi",
    project_id: null,
    caller_cwd: "/Volumes/WorkSSD/repos/llamactl",
  });

  expect(pathResolver).toHaveBeenCalledWith("/Volumes/WorkSSD/repos/llamactl");
  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "llamactl",
    }),
  );
  expect(res).toHaveProperty("resolution_warning", {
    code: "project_id_resolved_from_caller_cwd",
    resolved_project_id: "llamactl",
    caller_cwd: "/Volumes/WorkSSD/repos/llamactl",
  });
});

test("chain.start re-throws registry_unavailable when cwd resolver cannot load registry", async () => {
  const { daemon, startChain } = makeStartChain();
  const resolver = mock<() => string | undefined>(() => {
    throw new RegistryUnavailableError("failed to read project registry");
  });
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  await expectRejectsWith(
    handler({ initial_agent: "planner", message: "hi" }),
    /registry_unavailable/,
  );
  expect(startChain).not.toHaveBeenCalled();
});

test("chain.start without resolver opt passes through (legacy behavior)", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);

  await handler({ initial_agent: "planner", message: "hi" });

  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      initial_agent: "planner",
      message: "hi",
    }),
  );
  const recorded = calls(startChain);
  expect(recorded[0]?.project_id).toBeUndefined();
});

test("chain.start explicit-project_id-no-warning", async () => {
  const { daemon, startChain } = makeStartChain();
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  const res = await handler({ initial_agent: "planner", message: "hi", project_id: "sirius" });

  expect(resolver).not.toHaveBeenCalled();
  expect(res).not.toHaveProperty("resolution_warning");
  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "sirius",
    }),
  );
});

test("chain.start cwd-fallback-emits-warning-with-resolved-id", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  try {
    const res = await handler({ initial_agent: "planner", message: "hi" });

    expect(res).toHaveProperty("resolution_warning", {
      code: "project_id_inferred_from_mcp_cwd",
      resolved_project_id: "llamactl",
    });
    expect(startChain).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "llamactl",
      }),
    );
  } finally {
    if (oldRequireExplicit === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }
});

test("chain.start hard-mode-env-set-throws-with-correct-code-and-hint", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

  let error: unknown;
  try {
    await handler({ initial_agent: "planner", message: "hi" });
  } catch (err) {
    error = err;
  } finally {
    if (oldRequireExplicit === undefined) {
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    } else {
      process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
    }
  }
  expect(error).toBeInstanceOf(ProjectIdRequiredError);
  const err = error as ProjectIdRequiredError;
  expect(err.code).toBe("project_id_required");
  expect(err.resolvedProjectId).toBe("llamactl");
  expect(err.hint).toBe(
    "pass project_id explicitly, or unset PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy default",
  );
  expect(startChain).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledTimes(1);
});

test.each(["1", "true", "TRUE", "yes", "Yes", "on", "ON"])(
  "chain.start env-knob accepts %s case-insensitively",
  async (value) => {
    const { daemon, startChain } = makeStartChain();
    const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = value;
    const resolver = mock<() => string | undefined>(() => "llamactl");
    const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

    await expectRejectsWith(
      handler({ initial_agent: "planner", message: "hi" }),
      ProjectIdRequiredError,
    );
    if (oldRequireExplicit === undefined) {
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    } else {
      process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
    }
    expect(startChain).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledTimes(1);
  },
);

test.each(["", "0", "false", "FALSE", "no", "off", "maybe", " "])(
  "chain.start env-knob rejects %s and keeps legacy warning path",
  async (value) => {
    const { daemon, startChain } = makeStartChain();
    const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = value;
    const resolver = mock<() => string | undefined>(() => "llamactl");
    const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: resolver });

    const res = await handler({ initial_agent: "planner", message: "hi" });
    expect(res).toHaveProperty("resolution_warning", {
      code: "project_id_inferred_from_mcp_cwd",
      resolved_project_id: "llamactl",
    });
    if (oldRequireExplicit === undefined) {
      delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    } else {
      process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
    }
    expect(startChain).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "llamactl",
      }),
    );
    expect(resolver).toHaveBeenCalledTimes(1);
  },
);

test("chain.start caller_cwd resolves to a registered project and emits resolution_warning", async () => {
  const { daemon, startChain } = makeStartChain();
  const pathResolver = mock<(path: string) => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromPath: pathResolver });

  const res = await handler({
    initial_agent: "planner",
    message: "hi",
    caller_cwd: "/Volumes/WorkSSD/repos/llamactl",
  });

  expect(pathResolver).toHaveBeenCalledWith("/Volumes/WorkSSD/repos/llamactl");
  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "llamactl",
    }),
  );
  expect(res).toHaveProperty("resolution_warning", {
    code: "project_id_resolved_from_caller_cwd",
    resolved_project_id: "llamactl",
    caller_cwd: "/Volumes/WorkSSD/repos/llamactl",
  });
});

test("chain.start caller_cwd not registered throws caller_cwd_not_registered", async () => {
  const { daemon, startChain } = makeStartChain();
  const pathResolver = mock<(path: string) => string | undefined>(() => undefined);
  const handler = chainStartHandler(daemon, { resolveProjectIdFromPath: pathResolver });

  await expectRejectsWith(
    handler({
      initial_agent: "planner",
      message: "hi",
      caller_cwd: "/some/unregistered/path",
    }),
    CallerCwdNotRegisteredError,
  );
  expect(startChain).not.toHaveBeenCalled();
});

test("ChainStartInputShape rejects relative caller_cwd", () => {
  expect(() => ChainStartInputShape.caller_cwd.parse("relative/path")).toThrow(
    "caller_cwd must be an absolute path",
  );
});

test("chain.start explicit project_id wins over caller_cwd", async () => {
  const { daemon, startChain } = makeStartChain();
  const pathResolver = mock<(path: string) => string | undefined>(() => "llamactl");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromPath: pathResolver });

  const res = await handler({
    initial_agent: "planner",
    message: "hi",
    project_id: "sirius",
    caller_cwd: "/Volumes/WorkSSD/repos/llamactl",
  });

  expect(pathResolver).not.toHaveBeenCalled();
  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "sirius",
    }),
  );
  expect(res).not.toHaveProperty("resolution_warning");
});

test("chain.start no project_id and no caller_cwd falls through to daemon-cwd path", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  const cwdResolver = mock<() => string | undefined>(() => "penumbra");
  const handler = chainStartHandler(daemon, { resolveProjectIdFromCwd: cwdResolver });

  try {
    const res = await handler({ initial_agent: "planner", message: "hi" });

    expect(cwdResolver).toHaveBeenCalledTimes(1);
    expect(startChain).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "penumbra",
      }),
    );
    expect(res).toHaveProperty("resolution_warning", {
      code: "project_id_inferred_from_mcp_cwd",
      resolved_project_id: "penumbra",
    });
  } finally {
    if (oldRequireExplicit !== undefined) {
      process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
    }
  }
});

test("chain.start handler forwards daemon routing warnings into the MCP response", async () => {
  const { daemon, startChain } = makeStartChain({
    conversation_id: "conv-1",
    handoff_id: "h-1",
    routing_warning: {
      code: "prompt_project_mismatch",
      project_id: "penumbra",
      mentioned_paths: ["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"],
      missing_in_project: ["packages/train"],
      suggested_project_id: "llamactl",
      hint: "pass project_id explicitly or update prompt paths",
    },
  });
  const handler = chainStartHandler(daemon);

  const res = await handler({
    initial_agent: "planner",
    message: "hi",
    project_id: "penumbra",
    task_class: "STANDARD",
  });

  expect(res).toHaveProperty(
    "routing_warning",
    expect.objectContaining({
      code: "prompt_project_mismatch",
      project_id: "penumbra",
      mentioned_paths: ["/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts"],
      missing_in_project: ["packages/train"],
      suggested_project_id: "llamactl",
    }),
  );
  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: "penumbra",
    }),
  );
});

test("chain.start handler forwards isolated_install to daemon.startChain", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);

  await handler({
    initial_agent: "planner",
    message: "hi",
    task_class: "BOUNDARY",
    isolated_install: true,
  });

  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      isolated_install: true,
    }),
  );
});

test("chain.start handler forwards isolated_install: false explicitly", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartHandler(daemon);

  await handler({
    initial_agent: "planner",
    message: "hi",
    task_class: "STANDARD",
    isolated_install: false,
  });

  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      isolated_install: false,
    }),
  );
});
