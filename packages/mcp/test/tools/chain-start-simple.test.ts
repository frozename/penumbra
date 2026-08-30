import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { chainStartSimpleHandler } from "@src/tools/chain-start-simple.js";
import { ProjectIdRequiredError } from "@src/tools/chain-start.js";

import { fakeDaemon } from "../helpers.js";

type StartChainFn = DaemonClient["startChain"];

function makeStartChain(): { daemon: DaemonClient; startChain: StartChainFn } {
  const startChain = mock<StartChainFn>(() =>
    Promise.resolve({ conversation_id: "conv-1", handoff_id: "h-1" }),
  );
  return { daemon: fakeDaemon({ startChain }), startChain };
}

test("chain_start_simple throws project_id_required when env gate is set and project_id is omitted", async () => {
  const { daemon, startChain } = makeStartChain();
  const oldRequireExplicit = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "true";
  const resolver = mock<() => string | undefined>(() => "llamactl");
  const handler = chainStartSimpleHandler(daemon, { resolveProjectIdFromCwd: resolver });

  let caught: unknown;
  try {
    await handler({ initial_agent: "planner", message: "hi" });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ProjectIdRequiredError);

  if (oldRequireExplicit === undefined) {
    delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  } else {
    process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = oldRequireExplicit;
  }

  expect(startChain).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledTimes(1);
});

test("chain_start_simple succeeds when env gate is off and project_id is omitted", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartSimpleHandler(daemon);

  await handler({ initial_agent: "planner", message: "hi" });

  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "planner",
    message: "hi",
    task_class: "STANDARD",
    task_type: "debug_diagnose",
    use_worktree: false,
    max_hops: 2,
    trust_mode: "config",
  });
});

test("chain_start_simple forwards project_id through to chain_start", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartSimpleHandler(daemon);

  await handler({ initial_agent: "planner", message: "hi", project_id: "llamactl" });

  expect(startChain).toHaveBeenCalledWith(
    expect.objectContaining({
      initial_agent: "planner",
      message: "hi",
      task_class: "STANDARD",
      task_type: "debug_diagnose",
      project_id: "llamactl",
    }),
  );
});

test("chain_start_simple forwards long-lived dispatch identity fields when supplied", async () => {
  const { daemon, startChain } = makeStartChain();
  const handler = chainStartSimpleHandler(daemon);

  await handler({
    initial_agent: "planner",
    message: "hi",
    dispatch_kind: "long_lived_tick",
    long_lived_agent_id: "agent-1",
    long_lived_tick_id: "tick-1",
  });

  expect(startChain).toHaveBeenCalledWith({
    initial_agent: "planner",
    message: "hi",
    dispatch_kind: "long_lived_tick",
    long_lived_agent_id: "agent-1",
    long_lived_tick_id: "tick-1",
    task_class: "STANDARD",
    task_type: "debug_diagnose",
    use_worktree: false,
    max_hops: 2,
    trust_mode: "config",
  });
});
