import { recentCost } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { registerAdapter } from "@src/adapters/registry.js";
import { resolveCaptureAttribution, runChatTurn } from "@src/cli/loop.js";
import type { AgentChatConfig } from "@src/config/types.js";
import { PenumbraHttpError } from "@src/penumbra-client.js";
import type { Adapter, DispatchEvent, DispatchInput } from "@src/sdk/adapter.js";
import type { WriteToolsExecutor } from "@src/worker/write-tools-executor.js";

interface ObservedEvent {
  ts?: string;
  event_type?: string;
  lane?: string;
  provider?: string | null;
  model?: string | null;
  session_id?: string;
  source_detail?: string;
  cost_usd?: number | null;
  triggered_by_event_id?: string;
  payload_json?: {
    agent?: string;
    prompt?: string;
    response?: string;
    error?: string;
    handoff_id?: string | null;
    provider?: string;
    model?: string;
    source_kind?: string;
    tokens_cache_read?: number;
    tokens_cache_write?: number;
    tokens_input?: number;
    used?: number;
  };
}

interface AdapterOptions {
  mcpServers?: { name: string; command: string; args?: string[]; env?: unknown[] }[];
  claudeCodeAllowedTools?: string[];
  [key: string]: unknown;
}

function asyncIterableOf<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let i = 0;
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          if (i < items.length) {
            return Promise.resolve({ value: items[i++]!, done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

const cfg: AgentChatConfig = {
  agents: [{ name: "echo", adapter: "mock-echo", options: {}, roles: ["planner", "executor"] }],
  default_roles: { planner: "echo", executor: "echo" },
};

let eventCounter = 0;
const fakeObserve = (_event: unknown): Promise<{ event_id: string }> => {
  eventCounter++;
  return Promise.resolve({ event_id: `evt-${String(eventCounter)}` });
};

type MockFetchInput = string | URL;
const asFetchFn = (m: ReturnType<typeof mock>): typeof fetch => m as unknown as typeof fetch;

function makeCostDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE t0_events (
      event_id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      ingest_ts TEXT NOT NULL,
      source TEXT NOT NULL,
      source_detail TEXT,
      project_id TEXT,
      user_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      session_id TEXT,
      event_type TEXT NOT NULL,
      lane TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      latency_ms INTEGER,
      request_id TEXT,
      payload_json TEXT NOT NULL,
      payload_summary TEXT
    );
  `);
  return db;
}

function insertObservedUsage(db: Database, event: ObservedEvent): void {
  db.prepare(
    `
    INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, model, cost_usd, payload_json)
    VALUES ('usage-1', ?, ?, 'agentchat', 'u', 'm', 'usage-update', ?, ?, ?, ?, ?)
  `,
  ).run(
    event.ts ?? "2026-06-23T00:00:00.000Z",
    event.ts ?? "2026-06-23T00:00:00.000Z",
    event.lane ?? "cli-subscription",
    event.provider ?? null,
    event.model ?? null,
    event.cost_usd ?? null,
    JSON.stringify(event.payload_json ?? {}),
  );
}

test("runChatTurn dispatches the planner, observes prompt/response, and returns text + event_ids", async () => {
  registerAdapter("mock-echo", () => ({
    kind: "mock-echo",
    dispatch({ prompt }): Promise<{ text: string }> {
      return Promise.resolve({ text: `echo: ${prompt}` });
    },
  }));

  const observed: ObservedEvent[] = [];
  const trackingObserve = (event: unknown): Promise<{ event_id: string }> => {
    observed.push(event as ObservedEvent);
    return Promise.resolve({ event_id: `e-${String(observed.length)}` });
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
  expect(observed[0]!.event_type).toBe("agent-prompt");
  expect(observed[0]!.payload_json?.prompt).toBe("hello world");
  expect(observed[1]!.event_type).toBe("agent-response");
  expect(observed[1]!.source_detail).toBe("echo");
  expect(observed[1]!.payload_json?.agent).toBe("echo");
  expect(observed[1]!.payload_json?.response).toBe("echo: hello world");
  expect(observed[1]!.triggered_by_event_id).toBe("e-1");
});

test("runChatTurn records openai-compatible prompt-cache usage for cost cache-hit reporting", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = asFetchFn(
      mock((_url: MockFetchInput) =>
        Promise.resolve(
          new Response(
            [
              'data: {"choices":[{"delta":{"content":"cached answer"}}]}\n\n',
              'data: {"choices":[],"model":"gpt-cache","usage":{"prompt_tokens":100,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":25}}}\n\n',
              "data: [DONE]\n\n",
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    );

    const openAiCfg: AgentChatConfig = {
      agents: [
        {
          name: "wire-seat",
          adapter: "openai-compat-http",
          options: { baseUrl: "http://example/v1", apiKey: "tk", model: "gpt-cache" },
          subscription_provider: "openai",
          subscription_model: "gpt-cache",
          roles: ["planner"],
        },
      ],
      default_roles: { planner: "wire-seat" },
    };
    const observed: ObservedEvent[] = [];
    const result = await runChatTurn({
      config: openAiCfg,
      initialAgent: "wire-seat",
      userMessage: "use cache",
      conversation: { id: "c-cache", project_id: null },
      observe: (event: unknown): Promise<{ event_id: string }> => {
        observed.push(event as ObservedEvent);
        return Promise.resolve({ event_id: `e-${String(observed.length)}` });
      },
      handoff_id: "h-cache",
    });

    expect(result.text).toBe("cached answer");
    const usage = observed.find((event) => event.event_type === "usage-update");
    expect(usage).toBeDefined();
    expect(usage!.payload_json).toMatchObject({
      handoff_id: "h-cache",
      used: 104,
      tokens_cache_read: 25,
      tokens_cache_write: 0,
      tokens_input: 75,
      source_kind: "acp-wire",
    });

    const db = makeCostDb();
    try {
      insertObservedUsage(db, usage!);
      const cost = recentCost(db, { since: "2026-06-23T00:00:00.000Z" }, () => new Date());
      const row = cost.by_provider_model.find(
        (item) => item.provider === "openai" && item.model === "gpt-cache",
      );
      expect(row).toMatchObject({
        tokens_cache_read: 25,
        tokens_cache_write: 0,
        cache_read_pct: 0.25,
      });
    } finally {
      db.close();
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("runChatTurn captures an adapter throw as an agent-response error event and returns a turn with .error set", async () => {
  registerAdapter("mock-echo", () => ({
    kind: "mock-echo",
    dispatch(): Promise<{ text: string }> {
      throw new Error("adapter blew up");
    },
  }));

  const observed: ObservedEvent[] = [];
  const trackingObserve = (event: unknown): Promise<{ event_id: string }> => {
    observed.push(event as ObservedEvent);
    return Promise.resolve({ event_id: `e-${String(observed.length)}` });
  };

  const result = await runChatTurn({
    config: cfg,
    initialAgent: "echo",
    userMessage: "go",
    conversation: { id: "c-err", project_id: null },
    observe: trackingObserve,
  });

  expect(result.error?.message).toMatch(/adapter blew up/);
  expect(result.next_mention).toBeNull();

  expect(observed.length).toBe(2);
  expect(observed[0]!.event_type).toBe("agent-prompt");
  expect(observed[1]!.event_type).toBe("agent-response");
  expect(observed[1]!.payload_json?.agent).toBe("echo");
  expect(observed[1]!.payload_json?.error).toMatch(/adapter blew up/);
  expect(observed[1]!.triggered_by_event_id).toBe("e-1");
  expect(result.response_event_id).toBe("e-2");
});

test("runChatTurn extracts the first @mention from the response", async () => {
  registerAdapter("mock-echo", () => ({
    kind: "mock-echo",
    dispatch(): Promise<{ text: string }> {
      return Promise.resolve({ text: "Plan ready. @executor please run it." });
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
  const streamEvents: DispatchEvent[] = [
    { type: "delta", text: "hel" },
    { type: "delta", text: "lo " },
    { type: "delta", text: "world" },
    {
      type: "done",
      result: { text: "hello world", meta: { model: "m1", tokens_in: 1, tokens_out: 3 } },
    },
  ];
  registerAdapter("mock-echo", () => ({
    kind: "mock-echo",
    dispatch(): Promise<{ text: string }> {
      return Promise.resolve({ text: "should-not-be-called" });
    },
    dispatchStream(): AsyncIterable<DispatchEvent> {
      return asyncIterableOf(streamEvents);
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
    dispatch({ prompt }): Promise<{ text: string }> {
      return Promise.resolve({ text: `oneshot: ${prompt}` });
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
  let seenInput: DispatchInput | null = null;

  registerAdapter("mock-executor", () => ({
    kind: "mock-executor",
    dispatch(input): Promise<{ text: string }> {
      seenInput = input;
      return Promise.resolve({ text: "ok" });
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

  expect(seenInput!.executor).toBe(executor);
});

test("runChatTurn threads signal through to adapter.dispatch input", async () => {
  const controller = new AbortController();
  let seenInput: DispatchInput | null = null;

  registerAdapter("mock-signal", () => ({
    kind: "mock-signal",
    dispatch(input): Promise<{ text: string }> {
      seenInput = input;
      return Promise.resolve({ text: "ok" });
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

  expect(seenInput!.signal).toBe(controller.signal);
});

function makeOptionsCaptureAdapter(
  observedOptions: AdapterOptions[],
): (kind: string, opts: Record<string, unknown>) => Adapter {
  return (_kind, opts): Adapter => {
    observedOptions.push(opts);
    return {
      kind: "mock-hosted",
      dispatch(): Promise<{ text: string }> {
        return Promise.resolve({ text: "ok" });
      },
    };
  };
}

test("runChatTurn passes hosted_mcp_servers as mcpServers to buildAdapter", async () => {
  const observedOptions: AdapterOptions[] = [];
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
    buildAdapterOverride: makeOptionsCaptureAdapter(observedOptions),
  });

  expect(observedOptions[0]!.mcpServers).toEqual([
    {
      name: "ha",
      command: "uvx",
      args: ["ha-mcp"],
      env: [{ name: "HA_URL", value: "http://localhost:8123" }],
    },
  ]);
});

test("runChatTurn: yaml options.mcpServers take precedence on name conflict", async () => {
  const observedOptions: AdapterOptions[] = [];
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
    buildAdapterOverride: makeOptionsCaptureAdapter(observedOptions),
  });

  expect(observedOptions[0]!.mcpServers).toEqual([{ name: "ha", command: "custom-binary" }]);
});

test("runChatTurn: no hosted_mcp_servers leaves mcpServers from options only", async () => {
  const observedOptions: AdapterOptions[] = [];
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
    buildAdapterOverride: makeOptionsCaptureAdapter(observedOptions),
  });

  expect(observedOptions[0]!.mcpServers).toEqual([{ name: "penumbra", command: "custom-binary" }]);
});

test("auto-derives claudeCodeAllowedTools from mcp_allowlist when not already set", async () => {
  const observedOptions: AdapterOptions[] = [];
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
    buildAdapterOverride: makeOptionsCaptureAdapter(observedOptions),
  });

  expect(observedOptions[0]!.claudeCodeAllowedTools).toEqual([
    "mcp__ha__ha_pulse",
    "mcp__ha__ha_get_state",
    "mcp__ha__ha_call_service",
  ]);
});

test("does NOT override claudeCodeAllowedTools when already set in options", async () => {
  const observedOptions: AdapterOptions[] = [];
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
    buildAdapterOverride: makeOptionsCaptureAdapter(observedOptions),
  });

  expect(observedOptions[0]!.claudeCodeAllowedTools).toEqual(["mcp__ha__ha_pulse"]);
});

test("empty mcp_allowlist leaves claudeCodeAllowedTools unset", async () => {
  const observedOptions: AdapterOptions[] = [];
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
    buildAdapterOverride: makeOptionsCaptureAdapter(observedOptions),
  });

  expect(observedOptions[0]!.claudeCodeAllowedTools).toBeUndefined();
});

test("runChatTurn: agent without long_lived_config does not inject mcpServers", async () => {
  const observedOptions: AdapterOptions[] = [];
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
    buildAdapterOverride: makeOptionsCaptureAdapter(observedOptions),
  });

  expect(observedOptions[0]!.mcpServers).toBeUndefined();
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

  const observed: ObservedEvent[] = [];
  const result = await runChatTurn({
    config: capacityCfg,
    initialAgent: "gemini-capacity",
    userMessage: "go",
    conversation: { id: "conv-capacity", project_id: "project-1" },
    observe: (event: unknown): Promise<{ event_id: string }> => {
      observed.push(event as ObservedEvent);
      return Promise.resolve({ event_id: `event-${String(observed.length)}` });
    },
    handoff_id: "h-capacity",
  });

  expect(result.text.trim()).toBe("OK");
  const capacityEvent = observed.find((event) => event.event_type === "provider-capacity-error");
  expect(capacityEvent).toBeDefined();
  expect(capacityEvent!.provider).toBe("google");
  expect(capacityEvent!.model).toBe("gemini-3.1-pro-preview");
  expect(capacityEvent!.session_id).toBe("conv-capacity");
  expect(capacityEvent!.payload_json).toMatchObject({
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

test("resolveCaptureAttribution uses deepseek api_provider for api-mode usage rows", () => {
  expect(
    resolveCaptureAttribution({
      api_provider: "deepseek",
      options: { model: "deepseek-v4-flash" },
    }),
  ).toEqual({
    provider: "deepseek",
    model: "deepseek-v4-flash",
  });
});

test("resolveCaptureAttribution keeps Sakana openai-compatible seats in the sakana bucket", () => {
  expect(
    resolveCaptureAttribution({
      subscription_provider: "sakana",
      subscription_model: "fugu-ultra-20260615",
      options: { provider: "openai", model: "fugu-ultra" },
    }),
  ).toEqual({
    provider: "sakana",
    model: "fugu-ultra-20260615",
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

function makePendingObsHarness(opts: { failOn: (event: ObservedEvent) => Error | null }): {
  calls: ObservedEvent[];
  builds: string[];
  dispatches: number;
  cfg: AgentChatConfig;
  observe: (event: unknown) => Promise<{ event_id: string }>;
} {
  const calls: ObservedEvent[] = [];
  const builds: string[] = [];
  const harness = {
    calls,
    builds,
    dispatches: 0,
    cfg: {
      agents: [{ name: "echo-p10", adapter: "mock-p10-echo", options: {}, roles: ["planner"] }],
      default_roles: { planner: "echo-p10" },
    } as AgentChatConfig,
    observe: (event: unknown): Promise<{ event_id: string }> => {
      calls.push(event as ObservedEvent);
      const err = opts.failOn(event as ObservedEvent);
      if (err) return Promise.reject(err);
      return Promise.resolve({ event_id: `e-${String(calls.length)}` });
    },
  };
  registerAdapter("mock-p10-echo", () => {
    builds.push("mock-p10-echo");
    return {
      kind: "mock-p10-echo",
      dispatch({ prompt }: { prompt: string }): Promise<{ text: string }> {
        harness.dispatches++;
        return Promise.resolve({ text: `echo: ${prompt}` });
      },
    };
  });
  return harness;
}

test("runChatTurn surfaces pendingObservations when the agent-response observe fails transiently", async () => {
  const h = makePendingObsHarness({
    failOn: (event) =>
      event.event_type === "agent-response"
        ? new TypeError("The socket connection was closed unexpectedly")
        : null,
  });

  const result = await runChatTurn({
    config: h.cfg,
    initialAgent: "echo-p10",
    userMessage: "hello",
    conversation: { id: "c-p10", project_id: null },
    observe: h.observe,
    handoff_id: "h-p10",
  });

  // The adapter ran exactly once and the finished turn is NOT re-run or thrown
  // away just because the daemon call that reports it failed.
  expect(h.builds).toHaveLength(1);
  expect(h.dispatches).toBe(1);
  expect(result.text).toBe("echo: hello");
  expect(result.error).toBeUndefined();

  expect(result.pendingObservations).toHaveLength(1);
  const pending = result.pendingObservations![0]!;
  expect(pending.event_type).toBe("agent-response");
  expect(typeof pending.event_id).toBe("string");
  expect((pending.event_id as string).length).toBeGreaterThan(0);
  // The result's response_event_id is the pre-generated id — the observe never
  // returned a server id — and it matches the replayable envelope.
  expect(result.response_event_id).toBe(pending.event_id as string);
  expect((pending.payload_json as { response?: string }).response).toBe("echo: hello");
});

test("runChatTurn stamps a pre-generated event_id on every post-adapter observe envelope", async () => {
  const h = makePendingObsHarness({ failOn: () => null });

  const result = await runChatTurn({
    config: h.cfg,
    initialAgent: "echo-p10",
    userMessage: "hello",
    conversation: { id: "c-p10-ids", project_id: null },
    observe: h.observe,
    handoff_id: "h-p10-ids",
  });

  const responseCall = h.calls.find((call) => call.event_type === "agent-response");
  expect(responseCall).toBeDefined();
  const envelopeId = (responseCall as unknown as { event_id?: string }).event_id;
  expect(typeof envelopeId).toBe("string");
  // The sent envelope carried the id; the fake observe still assigns its own
  // returned id which the result reports on success.
  expect(result.response_event_id).toBe(`e-${String(h.calls.length)}`);
  expect(result.pendingObservations).toBeUndefined();
});

test("runChatTurn still surfaces the turn when the agent-response observe gets a daemon 400", async () => {
  const h = makePendingObsHarness({
    failOn: (event) =>
      event.event_type === "agent-response"
        ? new PenumbraHttpError("penumbra /observations: HTTP 400", 400, {
            error: { code: "validation_error" },
          })
        : null,
  });

  const result = await runChatTurn({
    config: h.cfg,
    initialAgent: "echo-p10",
    userMessage: "hello",
    conversation: { id: "c-p10-400", project_id: null },
    observe: h.observe,
  });

  // A terminal-class failure must not re-run the finished model turn either —
  // transient-vs-terminal only decides whether the outbox keeps the envelope.
  expect(h.dispatches).toBe(1);
  expect(result.text).toBe("echo: hello");
  expect(result.pendingObservations).toHaveLength(1);
  expect(result.pendingObservations![0]!.event_type).toBe("agent-response");
});

test("runChatTurn keeps envelopes ordered: a failed redaction observe leaves the agent-response pending too", async () => {
  registerAdapter("mock-p10-blocked", () => ({
    kind: "mock-p10-blocked",
    dispatch(): Promise<{ text: string }> {
      return Promise.resolve({ text: "rm -rf /Volumes/WorkSSD --no-preserve-root" });
    },
  }));
  const blockedCfg: AgentChatConfig = {
    agents: [{ name: "blocky", adapter: "mock-p10-blocked", options: {}, roles: ["planner"] }],
    default_roles: { planner: "blocky" },
  };
  const calls: ObservedEvent[] = [];
  const observe = (event: unknown): Promise<{ event_id: string }> => {
    calls.push(event as ObservedEvent);
    const typed = event as ObservedEvent;
    if (typed.event_type === "agent-response-blocked" || typed.event_type === "agent-response") {
      return Promise.reject(new TypeError("The socket connection was closed unexpectedly"));
    }
    return Promise.resolve({ event_id: `e-${String(calls.length)}` });
  };

  const result = await runChatTurn({
    config: blockedCfg,
    initialAgent: "blocky",
    userMessage: "please respond",
    conversation: { id: "c-p10-blocked", project_id: null },
    observe,
    handoff_id: "h-p10-blocked",
  });

  expect(result.text).toBe("[maestro response withheld by output policy]");
  const types = (result.pendingObservations ?? []).map((e) => e.event_type);
  expect(types).toEqual(["agent-response-blocked", "agent-response"]);
  const ids = (result.pendingObservations ?? []).map((e) => e.event_id);
  expect(new Set(ids).size).toBe(2);
  // The failed envelope itself is the first pending entry.
  expect(calls.at(-1)?.event_type).toBe("agent-response-blocked");
});

test("runChatTurn still throws when the PRE-adapter observe fails (the turn never ran)", async () => {
  const h = makePendingObsHarness({
    failOn: (event) =>
      event.event_type === "agent-prompt" ? new TypeError("socket closed") : null,
  });

  let thrown: unknown;
  try {
    await runChatTurn({
      config: h.cfg,
      initialAgent: "echo-p10",
      userMessage: "hello",
      conversation: { id: "c-p10-prompt", project_id: null },
      observe: h.observe,
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain("socket closed");
  // Re-running is safe: the adapter was never built or dispatched.
  expect(h.builds).toHaveLength(0);
  expect(h.dispatches).toBe(0);
});

test("runChatTurn threads permission_profile through to adapter.dispatch input", async () => {
  let seenInput: DispatchInput | null = null;

  registerAdapter("mock-profile", () => ({
    kind: "mock-profile",
    dispatch(input): Promise<{ text: string }> {
      seenInput = input;
      return Promise.resolve({ text: "ok" });
    },
  }));

  const cfgWithProfile: AgentChatConfig = {
    agents: [{ name: "echo", adapter: "mock-profile", options: {}, roles: ["planner"] }],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgWithProfile,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-profile", project_id: null },
    observe: fakeObserve,
    permission_profile: "review_readonly",
  });

  expect(seenInput!.permission_profile).toBe("review_readonly");
});

test("runChatTurn leaves permission_profile unset for unprofiled turns", async () => {
  let seenInput: DispatchInput | null = null;

  registerAdapter("mock-profile-none", () => ({
    kind: "mock-profile-none",
    dispatch(input): Promise<{ text: string }> {
      seenInput = input;
      return Promise.resolve({ text: "ok" });
    },
  }));

  const cfgNoProfile: AgentChatConfig = {
    agents: [{ name: "echo", adapter: "mock-profile-none", options: {}, roles: ["planner"] }],
    default_roles: { planner: "echo" },
  };

  await runChatTurn({
    config: cfgNoProfile,
    initialAgent: "echo",
    userMessage: "hello",
    conversation: { id: "c-no-profile", project_id: null },
    observe: fakeObserve,
  });

  expect(seenInput!.permission_profile).toBeUndefined();
});
