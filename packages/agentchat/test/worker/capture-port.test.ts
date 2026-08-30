import { CapturePort, type NotificationEvent } from "@src/worker/capture-port.js";
import { MaestroOutputRedactor } from "@src/worker/maestro-output-redactor.js";
import { describe, expect, it, spyOn, test } from "bun:test";

interface ObservedHit {
  rule_id: string;
}

interface ObservedPayload {
  handoff_id?: string;
  tool_call_id?: string;
  text?: string;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  status?: string;
  lifecycle?: string;
  truncated?: boolean;
  bytes_total?: number;
  used?: number;
  size?: number;
  currency?: string | null;
  source_kind?: string;
  raw_cost?: unknown;
  hits?: ObservedHit[];
  decision?: string;
  redacted_message?: string;
  rule_id?: string;
  provider?: string;
  model?: string | null;
  raw?: string;
}

interface ObservedEvent {
  ts?: string;
  source?: string;
  source_detail?: string;
  project_id?: string | null;
  session_id?: string;
  event_type?: string;
  lane?: string;
  provider?: string | null;
  model?: string | null;
  latency_ms?: number;
  cost_usd?: number | null;
  payload_json?: ObservedPayload;
  payload_summary?: string;
  triggered_by_event_id?: string;
}

interface Recorded {
  args: ObservedEvent;
  resolve: (v: { event_id: string }) => void;
  reject: (e: Error) => void;
}

interface FakeObserve {
  observe: (event: ObservedEvent) => Promise<{ event_id: string }>;
  calls: ObservedEvent[];
  resolveAll: () => void;
  rejectNext: (err: Error) => void;
}

function makeFakeObserve(): FakeObserve {
  const calls: ObservedEvent[] = [];
  let pending: Recorded[] = [];
  const observe = (event: ObservedEvent): Promise<{ event_id: string }> => {
    calls.push(event);
    return new Promise<{ event_id: string }>((resolve, reject) => {
      pending.push({ args: event, resolve, reject });
    });
  };
  const resolveAll = (): void => {
    const p = pending;
    pending = [];
    for (const c of p) {
      c.resolve({ event_id: `ev-${Math.random().toString(36).slice(2, 8)}` });
    }
  };
  const rejectNext = (err: Error): void => {
    const c = pending.shift();
    if (c) c.reject(err);
  };
  return { observe, calls, resolveAll, rejectNext };
}

function observed(calls: ObservedEvent[], index: number): ObservedEvent {
  const call = calls[index];
  if (call === undefined) throw new Error(`expected observe call at index ${String(index)}`);
  return call;
}

// Test-only typed factory: emits intentionally malformed NotificationEvent
// payloads (non-numeric `used`) to exercise the runtime guard in
// handleUsageUpdate. The public type declares `used: number`; the single
// documented `as unknown as` here is the established escape hatch for
// negative-path fixtures.
function makeMalformedUsageEvent(used: unknown): NotificationEvent {
  return { kind: "usage_update", used, size: 100000 } as unknown as NotificationEvent;
}

class ObserveError extends Error {
  readonly body: unknown;
  constructor(message: string, body: unknown) {
    super(message);
    this.body = body;
  }
}

const baseOpts = {
  chainId: "c-abc",
  handoffId: "h-xyz",
  projectId: "p-1",
  agentName: "mock-agent",
  provider: "mock",
  model: "mock-1",
  lane: "cloud" as const,
};

test("1. single thought chunk → close → one observe call (agent-thought)", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: "agent_thought_chunk", content: "hello" });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls).toHaveLength(1);
  const call = observed(f.calls, 0);
  expect(call.event_type).toBe("agent-thought");
  expect(call.payload_json?.text).toBe("hello");
  expect(call.session_id).toBe("c-abc");
});

test("2. N thought chunks → one coalesced observe call", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  for (const c of ["a", "b", "c", "d"]) port.emit({ kind: "agent_thought_chunk", content: c });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls).toHaveLength(1);
  expect(observed(f.calls, 0).payload_json?.text).toBe("abcd");
});

test("3. thought chunks then a tool_call → flush boundaries respected", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: "agent_thought_chunk", content: "thinking" });
  port.emit({ kind: "tool_call", toolCallId: "tc-1", status: "pending", input: { x: 1 } });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-1",
    status: "completed",
    output: { y: 2 },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls).toHaveLength(2);
  expect(observed(f.calls, 0).event_type).toBe("agent-thought");
  expect(observed(f.calls, 1).event_type).toBe("agent-tool-use");
});

test("4. tool_call start + terminal update → merged row with latency_ms", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: "tool_call", toolCallId: "tc-1", status: "pending", input: { path: "a.ts" } });
  await new Promise((r) => setTimeout(r, 5));
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-1",
    status: "completed",
    output: { ok: true },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls).toHaveLength(1);
  const r = observed(f.calls, 0);
  expect(r.event_type).toBe("agent-tool-use");
  expect(r.payload_json?.input).toEqual({ path: "a.ts" });
  expect(r.payload_json?.output).toEqual({ ok: true });
  expect(r.payload_json?.status).toBe("completed");
  expect(typeof r.latency_ms).toBe("number");
  expect(r.latency_ms).toBeGreaterThan(0);
});

test("5. tool_call start with no terminal → orphan row on close", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: "tool_call", toolCallId: "tc-orphan", status: "pending", input: { x: 1 } });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(f.calls).toHaveLength(1);
  const r = observed(f.calls, 0);
  expect(r.event_type).toBe("agent-tool-use");
  expect(r.payload_json?.status).toBe("canceled");
  expect(r.payload_json?.lifecycle).toBe("orphaned");
  expect(r.payload_json?.output).toBeNull();
});

test("6. >8 KB input/output → truncated with bytes_total", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  const big = "x".repeat(20_000);
  port.emit({ kind: "tool_call", toolCallId: "tc-big", status: "pending", input: { blob: big } });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-big",
    status: "completed",
    output: { blob: big },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const r = observed(f.calls, 0);
  expect(r.payload_json?.truncated).toBe(true);
  expect(r.payload_json?.bytes_total).toBeGreaterThan(8 * 1024);
  expect(JSON.stringify(r.payload_json?.input).length).toBeLessThanOrEqual(8 * 1024 + 256);
});

test("7. chainId=null → session_id falls back to handoffId", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, chainId: null, observe: f.observe });
  port.emit({ kind: "agent_thought_chunk", content: "x" });
  const closing = port.close();
  f.resolveAll();
  await closing;
  expect(observed(f.calls, 0).session_id).toBe("h-xyz");
});

test("8. observe rejection on one event → port records failure, does not throw", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: "agent_thought_chunk", content: "a" });
  port.emit({ kind: "tool_call", toolCallId: "t", status: "pending", input: {} });
  port.emit({ kind: "tool_call_update", toolCallId: "t", status: "completed", output: {} });
  f.rejectNext(new Error("observe down"));
  f.resolveAll();
  const closing = port.close();
  f.resolveAll();
  await closing;
  const stats = port.getStats();
  expect(stats.failed).toBeGreaterThanOrEqual(1);
  expect(stats.sent).toBeGreaterThanOrEqual(1);
});

test("9. close() awaits in-flight observe promises", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: "agent_thought_chunk", content: "x" });
  let closeResolved = false;
  const closing = port.close().then(() => {
    closeResolved = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(closeResolved).toBe(false);
  f.resolveAll();
  await closing;
  expect(closeResolved).toBe(true);
});

test("12. dispatch drops events past MAX_IN_FLIGHT cap and increments stats.dropped", async () => {
  // Stalled observe forces every dispatched event to remain in inFlight.
  const port = new CapturePort({
    ...baseOpts,
    closeTimeoutMs: 50,
    observe: (): Promise<{ event_id: string }> => new Promise(() => undefined),
  });
  const N = 300;
  for (let i = 0; i < N; i++) {
    // usage_update emits a discrete dispatch per event (no coalescing).
    port.emit({ kind: "usage_update", used: i + 1, size: 1000 });
  }
  const stats = port.getStats();
  expect(stats.dropped).toBeGreaterThan(0);
  expect(stats.dropped).toBe(N - 256);
  await port.close();
});

test("13. flush() attributes stalled observes to stats.timedOut (not just logging)", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
  const port = new CapturePort({
    ...baseOpts,
    closeTimeoutMs: 30,
    observe: (): Promise<{ event_id: string }> => new Promise(() => undefined),
  });
  port.emit({ kind: "usage_update", used: 1, size: 100 });
  port.emit({ kind: "usage_update", used: 2, size: 100 });
  await port.close();
  const stats = port.getStats();
  expect(stats.timedOut).toBeGreaterThanOrEqual(2);
  consoleError.mockRestore();
});

test("14. observe rejection with AbortError-like name increments stats.timedOut", async () => {
  class AbortLike extends Error {
    constructor() {
      super("aborted");
      this.name = "TimeoutError";
    }
  }
  const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
  const port = new CapturePort({
    ...baseOpts,
    observe: (): Promise<{ event_id: string }> => Promise.reject(new AbortLike()),
  });
  port.emit({ kind: "usage_update", used: 1, size: 100 });
  await port.flush();
  const stats = port.getStats();
  expect(stats.failed).toBeGreaterThanOrEqual(1);
  expect(stats.timedOut).toBeGreaterThanOrEqual(1);
  consoleError.mockRestore();
});

test("11. close() resolves within 300ms when in-flight requests stall", async () => {
  const port = new CapturePort({
    ...baseOpts,
    closeTimeoutMs: 200,
    observe: (): Promise<{ event_id: string }> => new Promise(() => undefined),
  });
  port.emit({ kind: "agent_thought_chunk", content: "stalled" });
  const startedAt = Date.now();
  await port.close();
  expect(Date.now() - startedAt).toBeLessThan(300);
});

test("10. observe rejection logs serialized body payload", async () => {
  const error = new ObserveError("penumbra /observations: HTTP 400", {
    error: {
      field_errors: [{ path: ["payload_json"], message: "expected record" }],
    },
  });
  const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
  const port = new CapturePort({
    ...baseOpts,
    observe: (): Promise<{ event_id: string }> => Promise.reject(error),
  });

  port.emit({ kind: "agent_message_chunk", content: "hi" });
  await port.flush();

  expect(consoleError).toHaveBeenCalledTimes(1);
  const message = String(consoleError.mock.calls.at(0)?.[0]);
  expect(message).toMatch(/observe failed/);
  expect(message).toMatch(/body=/);
  expect(message).toContain("field_errors");
  consoleError.mockRestore();
});

describe("CapturePort — capacity_error", () => {
  it("emits provider-capacity-error with provider/model/raw payload", async () => {
    const observed: ObservedEvent[] = [];
    const port = new CapturePort({
      observe: (e: ObservedEvent): Promise<{ event_id: string }> => {
        observed.push(e);
        return Promise.resolve({ event_id: "eid" });
      },
      chainId: "conv-capacity",
      handoffId: "h-capacity",
      projectId: "project-1",
      agentName: "gemini",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      lane: "cli-subscription",
      triggeredByEventId: "prompt-event-1",
    });

    port.emit({
      kind: "capacity_error",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      raw: "No capacity available for model gemini-3.1-pro-preview",
    });
    await port.flush();

    expect(observed).toHaveLength(1);
    const event = observed[0]!;
    expect(event.event_type).toBe("provider-capacity-error");
    expect(event.source).toBe("agentchat");
    expect(event.source_detail).toBe("gemini");
    expect(event.provider).toBe("google");
    expect(event.model).toBe("gemini-3.1-pro-preview");
    expect(event.session_id).toBe("conv-capacity");
    expect(event.payload_json).toEqual({
      handoff_id: "h-capacity",
      provider: "google",
      model: "gemini-3.1-pro-preview",
      raw: "No capacity available for model gemini-3.1-pro-preview",
      source_kind: "cli-spawn-stderr",
    });
    expect(event.payload_summary).toBe("google/gemini-3.1-pro-preview capacity error");
    expect(event.triggered_by_event_id).toBe("prompt-event-1");
  });
});

describe("CapturePort — usage_update", () => {
  it("emits a usage-update row when usage_update arrives with USD cost", async () => {
    const observed: ObservedEvent[] = [];
    const port = new CapturePort({
      observe: (e: ObservedEvent): Promise<{ event_id: string }> => {
        observed.push(e);
        return Promise.resolve({ event_id: "eid" });
      },
      chainId: "conv-1",
      handoffId: "h-1",
      projectId: null,
      agentName: "claude-acp-sonnet",
      provider: "anthropic",
      model: "sonnet-4",
      lane: "cli-subscription",
    });
    port.emit({
      kind: "usage_update",
      used: 5000,
      size: 200000,
      cost: { amount: 0.42, currency: "USD" },
    });
    await port.flush();
    expect(observed).toHaveLength(1);
    const event = observed[0]!;
    expect(event.event_type).toBe("usage-update");
    expect(event.cost_usd).toBe(0.42);
    expect(event.payload_json?.used).toBe(5000);
    expect(event.payload_json?.size).toBe(200000);
    expect(event.payload_json?.currency).toBe("USD");
    expect(event.payload_json?.source_kind).toBe("acp-wire");
  });

  it("emits a usage-update row with cost_usd=null when currency is not USD", async () => {
    const observed: ObservedEvent[] = [];
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args.join(" "));
    };
    try {
      const port = new CapturePort({
        observe: (e: ObservedEvent): Promise<{ event_id: string }> => {
          observed.push(e);
          return Promise.resolve({ event_id: "eid" });
        },
        chainId: null,
        handoffId: "h",
        projectId: null,
        agentName: "x",
        provider: null,
        model: null,
        lane: "cli-subscription",
      });
      port.emit({
        kind: "usage_update",
        used: 100,
        size: 100000,
        cost: { amount: 0.5, currency: "EUR" },
      });
      await port.flush();
      expect(observed).toHaveLength(1);
      const event = observed[0]!;
      expect(event.cost_usd).toBeNull();
      expect(event.payload_json?.raw_cost).toEqual({ amount: 0.5, currency: "EUR" });
      expect(errors.some((e) => e.includes("EUR not converted"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  it("drops usage_update when used is missing or non-numeric", async () => {
    const observed: ObservedEvent[] = [];
    const port = new CapturePort({
      observe: (e: ObservedEvent): Promise<{ event_id: string }> => {
        observed.push(e);
        return Promise.resolve({ event_id: "eid" });
      },
      chainId: null,
      handoffId: "h",
      projectId: null,
      agentName: "x",
      provider: null,
      model: null,
      lane: "cli-subscription",
    });
    port.emit({ kind: "usage_update", used: NaN, size: 100000 });
    port.emit(makeMalformedUsageEvent("oops"));
    await port.flush();
    expect(observed).toHaveLength(0);
  });
});

test("maestro redactor — rewrites agent-response on soft rule", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["planner"]),
      bypass: false,
      extraRules: [{ id: "soft_banana", pattern: /banana/g, replacement: "[REDACTED:banana]" }],
    }),
  });
  port.emit({ kind: "agent_message_chunk", content: "I like banana" });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const hit = f.calls.find((c) => c.event_type === "agent-response-redaction-hit");
  expect(hit).toBeDefined();
  expect(hit!.payload_json?.hits?.[0]?.rule_id).toBe("soft_banana");
  const resp = f.calls.find((c) => c.event_type === "agent-response");
  expect(resp).toBeDefined();
  expect(resp!.payload_json?.text).toBe("I like [REDACTED:banana]");
});

test("maestro redactor — blocks agent-response on fail-closed rule", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["planner"]),
      bypass: false,
    }),
  });
  port.emit({ kind: "agent_message_chunk", content: "I cannot run rm -rf /Volumes/WorkSSD" });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const blocked = f.calls.find((c) => c.event_type === "agent-response-blocked");
  expect(blocked).toBeDefined();
  expect(blocked!.payload_json?.hits?.[0]?.rule_id).toBe("destructive_shell_rmrf");
  expect(blocked!.payload_json?.decision).toBe("blocked");
  expect(blocked!.payload_json?.redacted_message).toBe(
    "[maestro response withheld by output policy]",
  );
  expect(f.calls.find((c) => c.event_type === "agent-response")).toBeUndefined();
});

test("maestro redactor — bypass surfaces a bypass note and the original text", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["planner"]),
      bypass: true,
    }),
  });
  port.emit({ kind: "agent_message_chunk", content: "rm -rf /Volumes/WorkSSD" });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const bypass = f.calls.find((c) => c.event_type === "agent-response-redaction-bypassed");
  expect(bypass).toBeDefined();
  expect(bypass!.payload_json?.hits?.[0]?.rule_id).toBe("destructive_shell_rmrf");
  const resp = f.calls.find((c) => c.event_type === "agent-response");
  expect(resp).toBeDefined();
  expect(resp!.payload_json?.text).toBe("rm -rf /Volumes/WorkSSD");
});

test("maestro redactor — no redactor option preserves prior behavior (back-compat)", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({ ...baseOpts, observe: f.observe });
  port.emit({ kind: "agent_message_chunk", content: "rm -rf /Volumes/WorkSSD" });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const resp = f.calls.find((c) => c.event_type === "agent-response");
  expect(resp).toBeDefined();
  expect(resp!.payload_json?.text).toBe("rm -rf /Volumes/WorkSSD");
  expect(f.calls.find((c) => (c.event_type ?? "").startsWith("agent-response-"))).toBeUndefined();
});

test("maestro redactor — agent-thought is NEVER redacted", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["planner"]),
      bypass: false,
    }),
  });
  port.emit({ kind: "agent_thought_chunk", content: "rm -rf /Volumes/WorkSSD" });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const thought = f.calls.find((c) => c.event_type === "agent-thought");
  expect(thought).toBeDefined();
  expect(thought!.payload_json?.text).toBe("rm -rf /Volumes/WorkSSD");
  expect(f.calls.find((c) => (c.event_type ?? "").startsWith("agent-response-"))).toBeUndefined();
});

test("maestro redactor — blocks agent-tool-use on fail-closed rule in tool input", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["claude-acp-sonnet"]),
      bypass: false,
    }),
  });
  port.emit({
    kind: "tool_call",
    toolCallId: "tc-rm",
    status: "pending",
    input: { cmd: "rm -rf /Volumes/WorkSSD" },
  });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-rm",
    status: "completed",
    output: { ok: true },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const blocked = f.calls.find((c) => c.event_type === "agent-tool-use-blocked");
  expect(blocked).toBeDefined();
  expect(blocked!.payload_json?.hits?.[0]?.rule_id).toBe("destructive_shell_rmrf");
  expect(blocked!.payload_json?.decision).toBe("blocked");
  expect(blocked!.payload_json?.redacted_message).toBe(
    "[maestro tool-use withheld by output policy]",
  );
  expect(f.calls.find((c) => c.event_type === "agent-tool-use")).toBeUndefined();
});

test("maestro redactor — preserves tool input when redaction is clean", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["claude-acp-sonnet"]),
      bypass: false,
    }),
  });
  port.emit({
    kind: "tool_call",
    toolCallId: "tc-ok",
    status: "pending",
    input: { query: "mtp memory allocation" },
  });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-ok",
    status: "completed",
    output: { count: 3 },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const ok = f.calls.find((c) => c.event_type === "agent-tool-use");
  expect(ok).toBeDefined();
  expect(ok!.payload_json?.input?.query).toBe("mtp memory allocation");
  expect(f.calls.find((c) => (c.event_type ?? "").startsWith("agent-tool-use-"))).toBeUndefined();
});

test("maestro redactor — rewrites tool input on soft rule", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["claude-acp-sonnet"]),
      bypass: false,
      extraRules: [{ id: "soft_banana", pattern: /banana/g, replacement: "[REDACTED:banana]" }],
    }),
  });
  port.emit({
    kind: "tool_call",
    toolCallId: "tc-banana",
    status: "pending",
    input: { query: "find banana split recipes" },
  });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-banana",
    status: "completed",
    output: { count: 0 },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const hit = f.calls.find((c) => c.event_type === "agent-tool-use-redaction-hit");
  expect(hit).toBeDefined();
  expect(hit!.payload_json?.hits?.[0]?.rule_id).toBe("soft_banana");
  const ok = f.calls.find((c) => c.event_type === "agent-tool-use");
  expect(ok).toBeDefined();
  expect(ok!.payload_json?.input?.query).toBe("find [REDACTED:banana] split recipes");
});

test("maestro redactor — bypass surfaces a note and the original tool input", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["claude-acp-sonnet"]),
      bypass: true,
    }),
  });
  port.emit({
    kind: "tool_call",
    toolCallId: "tc-bypass",
    status: "pending",
    input: { cmd: "rm -rf /Volumes/WorkSSD" },
  });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-bypass",
    status: "completed",
    output: { ok: true },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;
  const note = f.calls.find((c) => c.event_type === "agent-tool-use-redaction-bypassed");
  expect(note).toBeDefined();
  expect(note!.payload_json?.hits?.[0]?.rule_id).toBe("destructive_shell_rmrf");
  const ok = f.calls.find((c) => c.event_type === "agent-tool-use");
  expect(ok).toBeDefined();
  expect(ok!.payload_json?.input?.cmd).toBe("rm -rf /Volumes/WorkSSD");
});

test("maestro redactor — tool result clean keeps output unchanged and emits no tool-result redaction event", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["claude-acp-sonnet"]),
      bypass: false,
    }),
  });
  port.emit({
    kind: "tool_call",
    toolCallId: "tc-result-clean",
    status: "pending",
    input: { query: "safe" },
  });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-result-clean",
    status: "completed",
    output: { result: { nested: "all good" } },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;

  const row = f.calls.find((c) => c.event_type === "agent-tool-use");
  expect(row).toBeDefined();
  expect(row!.payload_json?.output).toEqual({ result: { nested: "all good" } });
  expect(
    f.calls.find((c) => (c.event_type ?? "").startsWith("agent-tool-result-")),
  ).toBeUndefined();
});

test("maestro redactor — tool result rewrite emits redaction-hit and stores rewritten output", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["claude-acp-sonnet"]),
      bypass: false,
      extraRules: [{ id: "soft_banana", pattern: /banana/g, replacement: "[REDACTED:banana]" }],
    }),
  });
  port.emit({
    kind: "tool_call",
    toolCallId: "tc-result-rewrite",
    status: "pending",
    input: { query: "safe" },
  });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-result-rewrite",
    status: "completed",
    output: { text: "banana split" },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;

  const hit = f.calls.find((c) => c.event_type === "agent-tool-result-redaction-hit");
  expect(hit).toBeDefined();
  expect(hit!.payload_json?.hits?.[0]?.rule_id).toBe("soft_banana");
  expect(f.calls.find((c) => c.event_type === "agent-tool-result-blocked")).toBeUndefined();

  const row = f.calls.find((c) => c.event_type === "agent-tool-use");
  expect(row).toBeDefined();
  expect(row!.payload_json?.output).toEqual({ text: "[REDACTED:banana] split" });
});

test("maestro redactor — tool result blocked emits blocked event and replaces payload with sentinel", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["claude-acp-sonnet"]),
      bypass: false,
    }),
  });
  port.emit({
    kind: "tool_call",
    toolCallId: "tc-result-block",
    status: "pending",
    input: { query: "safe" },
  });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-result-block",
    status: "completed",
    output: { result: { privateKeyPath: "~/.ssh/id_ed25519" } },
  });
  const closing = port.close();
  f.resolveAll();
  await closing;

  const blocked = f.calls.find((c) => c.event_type === "agent-tool-result-blocked");
  expect(blocked).toBeDefined();
  expect(blocked!.payload_json?.hits?.[0]?.rule_id).toBe("ssh_private_key_path");
  expect(blocked!.payload_json?.decision).toBe("blocked");
  expect(blocked!.payload_json?.redacted_message).toBe(
    "[maestro tool-result withheld by output policy]",
  );

  const row = f.calls.find((c) => c.event_type === "agent-tool-use");
  expect(row).toBeDefined();
  expect(row!.payload_json?.output).toEqual({
    redacted_message: "[maestro tool-result withheld by output policy]",
    rule_id: "ssh_private_key_path",
  });
});

test("maestro redactor — tool result bypass emits bypassed event and preserves original payload", async () => {
  const f = makeFakeObserve();
  const port = new CapturePort({
    ...baseOpts,
    observe: f.observe,
    maestroRedactor: new MaestroOutputRedactor({
      knownAgents: new Set(["claude-acp-sonnet"]),
      bypass: true,
    }),
  });
  const output = { result: { privateKeyPath: "~/.ssh/id_ed25519" } };
  port.emit({
    kind: "tool_call",
    toolCallId: "tc-result-bypass",
    status: "pending",
    input: { query: "safe" },
  });
  port.emit({
    kind: "tool_call_update",
    toolCallId: "tc-result-bypass",
    status: "completed",
    output,
  });
  const closing = port.close();
  f.resolveAll();
  await closing;

  const bypass = f.calls.find((c) => c.event_type === "agent-tool-result-redaction-bypassed");
  expect(bypass).toBeDefined();
  expect(bypass!.payload_json?.hits?.[0]?.rule_id).toBe("ssh_private_key_path");

  const row = f.calls.find((c) => c.event_type === "agent-tool-use");
  expect(row).toBeDefined();
  expect(row!.payload_json?.output).toEqual(output);
});
