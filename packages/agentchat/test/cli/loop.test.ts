import { expect, test } from "bun:test";
import { resolveCaptureAttribution, runChatTurn } from "../../src/cli/loop.js";
import type { AgentChatConfig } from "../../src/config/types.js";
import { registerAdapter } from "../../src/adapters/registry.js";
import type { WriteToolsExecutor } from "../../src/worker/write-tools-executor.js";

const cfg: AgentChatConfig = {
  agents: [{ name: "echo", adapter: "mock-echo", options: {}, roles: ["planner", "executor"] }],
  default_roles: { planner: "echo", executor: "echo" },
};

let eventCounter = 0;
const fakeObserve = async (event: any) => {
  eventCounter++;
  return { event_id: `evt-${eventCounter}` };
};

test("runChatTurn dispatches the planner, observes prompt/response, and returns text + event_ids", async () => {
  registerAdapter("mock-echo", () => ({
    kind: "mock-echo",
    async dispatch({ prompt }) {
      return { text: `echo: ${prompt}` };
    },
  }));

  const observed: any[] = [];
  const trackingObserve = async (event: any) => {
    observed.push(event);
    return { event_id: `e-${observed.length}` };
  };

  const result = await runChatTurn({
    config: cfg,
    initialAgent: "echo",
    userMessage: "hello world",
    conversation: { id: "c-1", project_id: "p-1" },
    observe: trackingObserve,
  });

  expect(result.text).toBe("echo: hello world");
  expect(result.next_mention).toBeNull();
  expect(result.prompt_event_id).toBe("e-1");
  expect(result.response_event_id).toBe("e-2");

  expect(observed.length).toBe(2);
  expect(observed[0].event_type).toBe("agent-prompt");
  expect(observed[0].payload_json.prompt).toBe("hello world");
  expect(observed[1].event_type).toBe("agent-response");
  expect(observed[1].payload_json.response).toBe("echo: hello world");
  expect(observed[1].triggered_by_event_id).toBe("e-1");
});

test("runChatTurn captures an adapter throw as an agent-response error event and returns a turn with .error set", async () => {
  registerAdapter("mock-echo", () => ({
    kind: "mock-echo",
    async dispatch() {
      throw new Error("adapter blew up");
    },
  }));

  const observed: any[] = [];
  const trackingObserve = async (event: any) => {
    observed.push(event);
    return { event_id: `e-${observed.length}` };
  };

  const result = await runChatTurn({
    config: cfg,
    initialAgent: "echo",
    userMessage: "go",
    conversation: { id: "c-err", project_id: null },
    observe: trackingObserve,
  });

  // No throw — the error is conveyed via the result.
  expect(result.error?.message).toMatch(/adapter blew up/);
  expect(result.next_mention).toBeNull();

  // Both events still observed: prompt (success) + response (error payload).
  expect(observed.length).toBe(2);
  expect(observed[0].event_type).toBe("agent-prompt");
  expect(observed[1].event_type).toBe("agent-response");
  expect(observed[1].payload_json.error).toMatch(/adapter blew up/);
  expect(observed[1].triggered_by_event_id).toBe("e-1");
  expect(result.response_event_id).toBe("e-2");
});

test("runChatTurn extracts the first @mention from the response", async () => {
  registerAdapter("mock-echo", () => ({
    kind: "mock-echo",
    async dispatch() {
      return { text: "Plan ready. @executor please run it." };
    },
  }));

  const result = await runChatTurn({
    config: cfg,
    initialAgent: "echo",
    userMessage: "go",
    conversation: { id: "c-1", project_id: null },
    observe: fakeObserve,
  });
  expect(result.next_mention?.target).toBe("executor");
});
test("runChatTurn streams text deltas to onChunk and accumulates the final text", async () => {
  registerAdapter("mock-echo", () => ({
    kind: "mock-echo",
    async dispatch() {
      return { text: "should-not-be-called" };
    },
    async *dispatchStream() {
      yield { type: "delta", text: "hel" };
      yield { type: "delta", text: "lo " };
      yield { type: "delta", text: "world" };
      yield {
        type: "done",
        result: { text: "hello world", meta: { model: "m1", tokens_in: 1, tokens_out: 3 } },
      };
    },
  }));

  const chunks: string[] = [];
  const result = await runChatTurn({
    config: cfg,
    initialAgent: "echo",
    userMessage: "hi",
    conversation: { id: "c-1", project_id: null },
    observe: fakeObserve,
    onChunk: (s) => chunks.push(s),
  });

  expect(chunks).toEqual(["hel", "lo ", "world"]);
  expect(result.text).toBe("hello world");
});

test("runChatTurn falls back to dispatch() and emits a single chunk for non-streaming adapters", async () => {
  registerAdapter("mock-echo", () => ({
    kind: "mock-echo",
    async dispatch({ prompt }) {
      return { text: `oneshot: ${prompt}` };
    },
  }));

  const chunks: string[] = [];
  const result = await runChatTurn({
    config: cfg,
    initialAgent: "echo",
    userMessage: "x",
    conversation: { id: "c-1", project_id: null },
    observe: fakeObserve,
    onChunk: (s) => chunks.push(s),
  });

  expect(chunks).toEqual(["oneshot: x"]);
  expect(result.text).toBe("oneshot: x");
});

test("runChatTurn threads executor through to adapter.dispatch input", async () => {
  const executor = { id: "exec-stub" } as unknown as WriteToolsExecutor;
  let seenInput: any = null;

  registerAdapter("mock-executor", () => ({
    kind: "mock-executor",
    async dispatch(input) {
      seenInput = input;
      return { text: "ok" };
    },
  }));

  const cfgWithExecutor: AgentChatConfig = {
    agents: [{ name: "echo", adapter: "mock-executor", options: {}, roles: ["planner"] }],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgWithExecutor,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-exec", project_id: null },
    observe: fakeObserve,
    executor,
  });

  expect(seenInput.executor).toBe(executor);
});

test("runChatTurn threads signal through to adapter.dispatch input", async () => {
  const controller = new AbortController();
  let seenInput: any = null;

  registerAdapter("mock-signal", () => ({
    kind: "mock-signal",
    async dispatch(input) {
      seenInput = input;
      return { text: "ok" };
    },
  }));

  const cfgWithSignal: AgentChatConfig = {
    agents: [{ name: "echo", adapter: "mock-signal", options: {}, roles: ["planner"] }],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgWithSignal,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-signal", project_id: null },
    observe: fakeObserve,
    signal: controller.signal,
  });

  expect(seenInput.signal).toBe(controller.signal);
});

test("runChatTurn passes hosted_mcp_servers as mcpServers to buildAdapter", async () => {
  const observedOptions: any[] = [];
  const cfgWithHosted: AgentChatConfig = {
    agents: [
      {
        name: "echo",
        adapter: "mock-hosted",
        options: {},
        roles: ["planner"],
        long_lived: true,
        long_lived_config: {
          bounds: { wall_clock_ms: 120000, cost_cents: 10, max_sub_dispatches: 1 },
          hosted_mcp_servers: [
            {
              name: "ha",
              command: "uvx",
              args: ["ha-mcp"],
              env: [{ name: "HA_URL", value: "http://localhost:8123" }],
            },
          ],
          mcp_allowlist: [],
          standing_brief: "brief",
        },
      },
    ],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgWithHosted,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-hosted", project_id: null },
    observe: fakeObserve,
    buildAdapterOverride: (_kind, opts) => {
      observedOptions.push(opts);
      return {
        kind: "mock-hosted",
        async dispatch() {
          return { text: "ok" };
        },
      };
    },
  });

  expect(observedOptions[0].mcpServers).toEqual([
    {
      name: "ha",
      command: "uvx",
      args: ["ha-mcp"],
      env: [{ name: "HA_URL", value: "http://localhost:8123" }],
    },
  ]);
});

test("runChatTurn: yaml options.mcpServers take precedence on name conflict", async () => {
  const observedOptions: any[] = [];
  const cfgWithConflict: AgentChatConfig = {
    agents: [
      {
        name: "echo",
        adapter: "mock-hosted",
        options: {
          mcpServers: [{ name: "ha", command: "custom-binary" }],
        },
        roles: ["planner"],
        long_lived: true,
        long_lived_config: {
          bounds: { wall_clock_ms: 120000, cost_cents: 10, max_sub_dispatches: 1 },
          hosted_mcp_servers: [
            {
              name: "ha",
              command: "uvx",
              args: ["ha-mcp"],
              env: [{ name: "HA_URL", value: "http://localhost:8123" }],
            },
          ],
          mcp_allowlist: [],
          standing_brief: "brief",
        },
      },
    ],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgWithConflict,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-conflict", project_id: null },
    observe: fakeObserve,
    buildAdapterOverride: (_kind, opts) => {
      observedOptions.push(opts);
      return {
        kind: "mock-hosted",
        async dispatch() {
          return { text: "ok" };
        },
      };
    },
  });

  expect(observedOptions[0].mcpServers).toEqual([{ name: "ha", command: "custom-binary" }]);
});

test("runChatTurn: no hosted_mcp_servers leaves mcpServers from options only", async () => {
  const observedOptions: any[] = [];
  const cfgNoHosted: AgentChatConfig = {
    agents: [
      {
        name: "echo",
        adapter: "mock-hosted",
        options: {
          mcpServers: [{ name: "penumbra", command: "custom-binary" }],
        },
        roles: ["planner"],
        long_lived: true,
        long_lived_config: {
          bounds: { wall_clock_ms: 120000, cost_cents: 10, max_sub_dispatches: 1 },
          hosted_mcp_servers: [],
          mcp_allowlist: [],
          standing_brief: "brief",
        },
      },
    ],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgNoHosted,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-no-hosted", project_id: null },
    observe: fakeObserve,
    buildAdapterOverride: (_kind, opts) => {
      observedOptions.push(opts);
      return {
        kind: "mock-hosted",
        async dispatch() {
          return { text: "ok" };
        },
      };
    },
  });

  expect(observedOptions[0].mcpServers).toEqual([{ name: "penumbra", command: "custom-binary" }]);
});

test("auto-derives claudeCodeAllowedTools from mcp_allowlist when not already set", async () => {
  const observedOptions: any[] = [];
  const cfgWithHosted: AgentChatConfig = {
    agents: [
      {
        name: "echo",
        adapter: "mock-hosted",
        options: {},
        roles: ["planner"],
        long_lived: true,
        long_lived_config: {
          bounds: { wall_clock_ms: 120000, cost_cents: 10, max_sub_dispatches: 1 },
          hosted_mcp_servers: [
            {
              name: "ha",
              command: "uvx",
              args: ["ha-mcp"],
              env: [{ name: "HA_URL", value: "http://localhost:8123" }],
            },
          ],
          mcp_allowlist: ["ha:ha_pulse", "ha:ha_get_state", "ha:ha_call_service"],
          standing_brief: "brief",
        },
      },
    ],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgWithHosted,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-derive-tools", project_id: null },
    observe: fakeObserve,
    buildAdapterOverride: (_kind, opts) => {
      observedOptions.push(opts);
      return {
        kind: "mock-hosted",
        async dispatch() {
          return { text: "ok" };
        },
      };
    },
  });

  expect(observedOptions[0].claudeCodeAllowedTools).toEqual([
    "mcp__ha__ha_pulse",
    "mcp__ha__ha_get_state",
    "mcp__ha__ha_call_service",
  ]);
});

test("does NOT override claudeCodeAllowedTools when already set in options", async () => {
  const observedOptions: any[] = [];
  const cfgWithHosted: AgentChatConfig = {
    agents: [
      {
        name: "echo",
        adapter: "mock-hosted",
        options: {
          claudeCodeAllowedTools: ["mcp__ha__ha_pulse"],
        },
        roles: ["planner"],
        long_lived: true,
        long_lived_config: {
          bounds: { wall_clock_ms: 120000, cost_cents: 10, max_sub_dispatches: 1 },
          hosted_mcp_servers: [
            {
              name: "ha",
              command: "uvx",
              args: ["ha-mcp"],
              env: [{ name: "HA_URL", value: "http://localhost:8123" }],
            },
          ],
          mcp_allowlist: ["ha:ha_pulse", "ha:ha_get_state", "ha:ha_call_service"],
          standing_brief: "brief",
        },
      },
    ],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgWithHosted,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-no-override", project_id: null },
    observe: fakeObserve,
    buildAdapterOverride: (_kind, opts) => {
      observedOptions.push(opts);
      return {
        kind: "mock-hosted",
        async dispatch() {
          return { text: "ok" };
        },
      };
    },
  });

  expect(observedOptions[0].claudeCodeAllowedTools).toEqual(["mcp__ha__ha_pulse"]);
});

test("empty mcp_allowlist leaves claudeCodeAllowedTools unset", async () => {
  const observedOptions: any[] = [];
  const cfgWithHosted: AgentChatConfig = {
    agents: [
      {
        name: "echo",
        adapter: "mock-hosted",
        options: {},
        roles: ["planner"],
        long_lived: true,
        long_lived_config: {
          bounds: { wall_clock_ms: 120000, cost_cents: 10, max_sub_dispatches: 1 },
          hosted_mcp_servers: [
            {
              name: "ha",
              command: "uvx",
              args: ["ha-mcp"],
              env: [{ name: "HA_URL", value: "http://localhost:8123" }],
            },
          ],
          mcp_allowlist: [],
          standing_brief: "brief",
        },
      },
    ],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgWithHosted,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-empty-allowlist", project_id: null },
    observe: fakeObserve,
    buildAdapterOverride: (_kind, opts) => {
      observedOptions.push(opts);
      return {
        kind: "mock-hosted",
        async dispatch() {
          return { text: "ok" };
        },
      };
    },
  });

  expect(observedOptions[0].claudeCodeAllowedTools).toBeUndefined();
});

test("runChatTurn: agent without long_lived_config does not inject mcpServers", async () => {
  const observedOptions: any[] = [];
  const cfgStandard: AgentChatConfig = {
    agents: [
      {
        name: "echo",
        adapter: "mock-hosted",
        options: {},
        roles: ["planner"],
      },
    ],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgStandard,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-standard", project_id: null },
    observe: fakeObserve,
    buildAdapterOverride: (_kind, opts) => {
      observedOptions.push(opts);
      return {
        kind: "mock-hosted",
        async dispatch() {
          return { text: "ok" };
        },
      };
    },
  });

  expect(observedOptions[0].mcpServers).toBeUndefined();
});

test("runChatTurn observes provider-capacity-error emitted by cli-spawn adapters", async () => {
  const capacityCfg: AgentChatConfig = {
    agents: [
      {
        name: "gemini-capacity",
        adapter: "gemini-cli",
        options: {
          command: "sh",
          args: [
            "-c",
            'echo "No capacity available for model gemini-3.1-pro-preview" 1>&2; echo OK',
          ],
          pass_via: "argv",
          provider: "google",
          model: "gemini-3.1-pro-preview",
        },
        roles: ["planner"],
      },
    ],
    default_roles: { planner: "gemini-capacity" },
  };

  const observed: any[] = [];
  const result = await runChatTurn({
    config: capacityCfg,
    initialAgent: "gemini-capacity",
    userMessage: "go",
    conversation: { id: "conv-capacity", project_id: "project-1" },
    observe: async (event) => {
      observed.push(event);
      return { event_id: `event-${observed.length}` };
    },
    handoff_id: "h-capacity",
  });

  expect(result.text.trim()).toBe("OK");
  const capacityEvent = observed.find((event) => event.event_type === "provider-capacity-error");
  expect(capacityEvent).toBeDefined();
  expect(capacityEvent.provider).toBe("google");
  expect(capacityEvent.model).toBe("gemini-3.1-pro-preview");
  expect(capacityEvent.session_id).toBe("conv-capacity");
  expect(capacityEvent.payload_json).toMatchObject({
    handoff_id: "h-capacity",
    provider: "google",
    model: "gemini-3.1-pro-preview",
    source_kind: "cli-spawn-stderr",
  });
});

test("resolveCaptureAttribution prefers subscription_provider and subscription_model", () => {
  expect(
    resolveCaptureAttribution({
      subscription_provider: "anthropic",
      subscription_model: "claude-sonnet-4",
      options: {},
    }),
  ).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
});

test("resolveCaptureAttribution falls back to adapter options when subscription fields are absent", () => {
  expect(
    resolveCaptureAttribution({
      options: { provider: "openai-compat", model: "gpt-4.1" },
    }),
  ).toEqual({
    provider: "openai-compat",
    model: "gpt-4.1",
  });
});

test("resolveCaptureAttribution lets subscription fields win over adapter options", () => {
  expect(
    resolveCaptureAttribution({
      subscription_provider: "anthropic",
      subscription_model: "claude-sonnet-4",
      options: { provider: "foo", model: "bar" },
    }),
  ).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
});

test("resolveCaptureAttribution returns nulls when neither source is present", () => {
  expect(
    resolveCaptureAttribution({
      options: {},
    }),
  ).toEqual({
    provider: null,
    model: null,
  });
});
