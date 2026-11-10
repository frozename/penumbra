import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it, vi } from "bun:test";

import { createAcpWarmPool } from "@src/adapters/acp-warm-pool.js";
import { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import type { StartStdioAcpServerOptions, StdioAcpHandle } from "@src/adapters/stdio-acp-server.js";
import { StdioAcpAdapter, type StdioAcpOptions } from "@src/adapters/stdio-acp.js";
import type { DispatchInput, DispatchOutput } from "@src/sdk/adapter.js";

import {
  makeMockAcpClient,
  makeMockAcpHandle,
  makeStandardClientRequest,
  type MockAcpHandle,
} from "../helpers/stdio-acp-fixtures.js";

/**
 * #592: per-project env overlay for ACP seats. agents.yaml `env_by_project`
 * maps a project_id to extra spawn env; the adapter resolves
 * input.conversation.project_id at dispatch time and overlays those vars on
 * top of opts.env (unsetEnv still wins). These tests pin the spawn-env
 * contract plus the warm-pool isolation that keeps an overlay-less prewarmed
 * process from serving an overlay dispatch.
 */

type AcpStartServerMock = ReturnType<typeof vi.fn<typeof startStdioAcpServerStub>>;
function startStdioAcpServerStub(_opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> {
  return Promise.resolve(makeMockAcpHandle());
}

/** Build a startServer mock that captures the env passed by the adapter. */
function envCapturingStartServer(handle: MockAcpHandle): {
  startServer: AcpStartServerMock;
  getEnv: () => Record<string, string> | undefined;
} {
  let captured: Record<string, string> | undefined;
  const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
  startServer.mockImplementation((opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> => {
    captured = opts.env;
    return Promise.resolve(handle);
  });
  return { startServer, getEnv: (): Record<string, string> | undefined => captured };
}

/**
 * startServer mock that captures every spawn env and returns a fresh
 * never-exiting handle per call, so two pooled processes can coexist.
 */
function envCapturingFreshHandleStartServer(): {
  startServer: AcpStartServerMock;
  envs: (Record<string, string> | undefined)[];
} {
  const envs: (Record<string, string> | undefined)[] = [];
  const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
  startServer.mockImplementation((opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> => {
    envs.push(opts.env);
    return Promise.resolve(
      makeMockAcpHandle({
        pid: 4000 + envs.length,
        exited: new Promise<number | null>(() => {
          /* never resolves: pooled entries must stay alive for the test */
        }),
      }),
    );
  });
  return { startServer, envs };
}

/**
 * Create a client whose request method short-circuits the standard
 * initialize/session-new/session-prompt path. Used by env-capture tests that
 * only care about the spawn env, not the prompt-side behavior.
 */
function makeCreateClientWithStandardRequest(): (h: StdioAcpHandle) => StdioAcpClient {
  return (h: StdioAcpHandle): StdioAcpClient => {
    const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
    client.request = makeStandardClientRequest();
    return client;
  };
}

function makeMockClient(): StdioAcpClient {
  return makeMockAcpClient({
    onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
    on: vi.fn<StdioAcpClient["on"]>(),
    request: makeStandardClientRequest(),
  });
}

function dispatch(
  adapter: StdioAcpAdapter,
  input: Omit<DispatchInput, "conversation" | "config"> &
    Partial<Pick<DispatchInput, "conversation" | "config">>,
): Promise<DispatchOutput> {
  return adapter.dispatch({
    conversation: { id: "conv-1", project_id: null },
    config: {},
    ...input,
  });
}

const BASE_OPTS = {
  binary: "fake-acp",
  env: { BASE_K: "1", PENUMBRA_WORKER_INSTRUCTIONS: "/base.md" },
};

const LLAMACTL_OVERLAY = {
  PENUMBRA_WORKER_INSTRUCTIONS: "/abs/WORKER-llamactl.md",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
};

const OVERLAY_OPTS = {
  ...BASE_OPTS,
  envByProject: { llamactl: LLAMACTL_OVERLAY },
} as StdioAcpOptions;

function createOverlayAdapter(startServer: AcpStartServerMock): StdioAcpAdapter {
  return new StdioAcpAdapter(OVERLAY_OPTS, {
    startServer,
    createClient: makeCreateClientWithStandardRequest(),
  });
}

function createWarmAdapter(): {
  adapter: StdioAcpAdapter;
  startServer: AcpStartServerMock;
  envs: (Record<string, string> | undefined)[];
} {
  const { startServer, envs } = envCapturingFreshHandleStartServer();
  const opts = {
    ...BASE_OPTS,
    agentName: "seat",
    repoRoot: "/r",
    cwd: "/r",
    warmPool: true,
    envByProject: { llamactl: LLAMACTL_OVERLAY },
  } as StdioAcpOptions;
  const adapter = new StdioAcpAdapter(opts, {
    startServer,
    createClient: (): StdioAcpClient => makeMockClient(),
    pool: createAcpWarmPool(),
  });
  return { adapter, startServer, envs };
}

describe("StdioAcpAdapter env_by_project overlay (#592)", () => {
  it("applies the overlay for the matching project", async () => {
    const handle = makeMockAcpHandle();
    const { startServer, getEnv } = envCapturingStartServer(handle);
    const adapter = createOverlayAdapter(startServer);

    await dispatch(adapter, {
      prompt: "hi",
      signal: new AbortController().signal,
      conversation: { id: "c", project_id: "llamactl" },
    });

    const capturedEnv = getEnv();
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).toHaveProperty("PENUMBRA_WORKER_INSTRUCTIONS", "/abs/WORKER-llamactl.md");
    expect(capturedEnv).toHaveProperty("OPENCODE_DISABLE_PROJECT_CONFIG", "1");
    expect(capturedEnv).toHaveProperty("BASE_K", "1");
  });

  it("other project gets no overlay", async () => {
    const handle = makeMockAcpHandle();
    const { startServer, getEnv } = envCapturingStartServer(handle);
    const adapter = createOverlayAdapter(startServer);

    await dispatch(adapter, {
      prompt: "hi",
      signal: new AbortController().signal,
      conversation: { id: "c", project_id: "penumbra" },
    });

    const capturedEnv = getEnv();
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).toHaveProperty("PENUMBRA_WORKER_INSTRUCTIONS", "/base.md");
    expect(capturedEnv).not.toHaveProperty("OPENCODE_DISABLE_PROJECT_CONFIG");
  });

  it("byte-identical without overlay", async () => {
    const spawnEnv = async (
      opts: StdioAcpOptions,
      projectId: string | null,
    ): Promise<Record<string, string> | undefined> => {
      const handle = makeMockAcpHandle();
      const { startServer, getEnv } = envCapturingStartServer(handle);
      const adapter = new StdioAcpAdapter(opts, {
        startServer,
        createClient: makeCreateClientWithStandardRequest(),
      });
      await dispatch(adapter, {
        prompt: "hi",
        signal: new AbortController().signal,
        conversation: { id: "c", project_id: projectId },
      });
      return getEnv();
    };

    const envA = await spawnEnv(BASE_OPTS, "llamactl");
    const envB = await spawnEnv(OVERLAY_OPTS, null);
    const envC = await spawnEnv(OVERLAY_OPTS, "unknown");

    expect(envA).toBeDefined();
    expect(envB).toEqual(envA);
    expect(envC).toEqual(envA);
  });

  it("unsetEnv beats overlay", async () => {
    const handle = makeMockAcpHandle();
    const { startServer, getEnv } = envCapturingStartServer(handle);
    const opts = {
      ...BASE_OPTS,
      unsetEnv: ["SECRET_X"],
      envByProject: { llamactl: { SECRET_X: "v" } },
    } as StdioAcpOptions;
    const adapter = new StdioAcpAdapter(opts, {
      startServer,
      createClient: makeCreateClientWithStandardRequest(),
    });

    await dispatch(adapter, {
      prompt: "hi",
      signal: new AbortController().signal,
      conversation: { id: "c", project_id: "llamactl" },
    });

    const capturedEnv = getEnv();
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty("SECRET_X");
  });

  it("warm pool does not reuse an overlay-less process for an overlay dispatch", async () => {
    const { adapter, startServer, envs } = createWarmAdapter();

    await adapter.prewarm();
    await dispatch(adapter, {
      prompt: "hi",
      signal: new AbortController().signal,
      conversation: { id: "c", project_id: "llamactl" },
    });

    expect(startServer).toHaveBeenCalledTimes(2);
    expect(envs[1]).toHaveProperty("PENUMBRA_WORKER_INSTRUCTIONS", "/abs/WORKER-llamactl.md");
  });

  it("warm reuse unchanged without overlay", async () => {
    const { adapter, startServer } = createWarmAdapter();

    await adapter.prewarm();
    await dispatch(adapter, {
      prompt: "hi",
      signal: new AbortController().signal,
      conversation: { id: "c", project_id: "penumbra" },
    });

    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("no env values in events", async () => {
    const handle = makeMockAcpHandle();
    const { startServer } = envCapturingStartServer(handle);
    const adapter = createOverlayAdapter(startServer);
    const events: DispatchEventInput[] = [];

    await dispatch(adapter, {
      prompt: "hi",
      signal: new AbortController().signal,
      conversation: { id: "c", project_id: "llamactl" },
      eventContext: { handoffId: "h-592", workerId: "w-592" },
      onEvent: (event: DispatchEventInput): void => {
        events.push(event);
      },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("/abs/WORKER-llamactl.md");
  });
});
