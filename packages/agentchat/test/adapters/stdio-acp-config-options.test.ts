import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAcpWarmPool } from "@src/adapters/acp-warm-pool.js";
import { createStdioAcpAdapter } from "@src/adapters/registry.js";
import { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import { startStdioAcpServer } from "@src/adapters/stdio-acp-server.js";
import { StdioAcpAdapter } from "@src/adapters/stdio-acp.js";
import type { Adapter } from "@src/sdk/adapter.js";

interface Scenario {
  configOptions?: unknown;
  models?: unknown;
  responses?: unknown[];
  rejectAt?: number;
  hangAt?: number;
}
interface WireCall {
  method: string;
  params?: Record<string, unknown>;
}

const option = (
  id: string,
  currentValue: string,
  values: string[],
  category?: string,
): Record<string, unknown> => ({
  id,
  name: id,
  type: "select",
  currentValue,
  category,
  options: values.map((value) => ({ value, name: value })),
});
const model = option("family", "p/default", ["p/default", "p/wanted"], "model");
const effort = option("effort", "low", ["low", "high"], "thought_level");
const fixture = new URL("../fixtures/config-options-acp.mjs", import.meta.url).pathname;

async function run(
  scenario: Scenario,
  selection: Record<string, unknown> = { model: "p/wanted" },
  factory = false,
  laterSelections: Record<string, unknown>[] = [],
): Promise<{
  calls: WireCall[];
  events: DispatchEventInput[];
  error: string | null;
}> {
  const dir = await mkdtemp(join(tmpdir(), "acp-config-pin-"));
  const log = join(dir, "wire.jsonl");
  const events: DispatchEventInput[] = [];
  const opts = {
    binary: process.execPath,
    args: [fixture, log, JSON.stringify(scenario)],
    cwd: dir,
    bootTimeoutMs: 2_000,
    modelWarmupPrompt: "warmup",
    ...selection,
  };
  const pool = createAcpWarmPool();
  const adapterFor = (overrides: Record<string, unknown>): Adapter =>
    laterSelections.length > 0
      ? new StdioAcpAdapter(
          { ...opts, ...overrides, warmPool: true },
          {
            pool,
            startServer: startStdioAcpServer,
            createClient: (handle): StdioAcpClient =>
              new StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout }),
          },
        )
      : factory
        ? createStdioAcpAdapter(opts)
        : new StdioAcpAdapter(opts);
  try {
    let error: string | null = null;
    for (const overrides of [selection, ...laterSelections]) {
      error = await adapterFor(overrides)
        .dispatch({
          prompt: "task",
          conversation: { id: "c1", project_id: null },
          config: {},
          signal: new AbortController().signal,
          eventContext: { handoffId: "h1", workerId: "w1" },
          onEvent: (event) => {
            events.push(event);
          },
        })
        .then(
          () => null,
          (err: unknown) => String(err),
        );
      if (error !== null) break;
    }
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as WireCall);
    return { calls, events, error };
  } finally {
    pool.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}
const methods = (calls: WireCall[]): string[] => calls.map((call) => call.method);
const selected = (events: DispatchEventInput[]): DispatchEventInput | undefined =>
  events.find((event) => event.kind === "acp.model_selected");

describe("stdio-acp advertised config-option pins (#328)", () => {
  test("selects a literal advertised model before warmup and task prompts", async () => {
    const { calls, events, error } = await run({ configOptions: [model] });
    expect(error).toBeNull();
    expect(methods(calls)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
      "session/prompt",
    ]);
    expect(calls[2]?.params).toEqual({
      sessionId: "fixture-session",
      configId: "family",
      value: "p/wanted",
    });
    expect(selected(events)?.meta).toMatchObject({
      model: "p/wanted",
      mechanism: "config_options",
      config_options: { family: "p/wanted" },
      backend_model_uid: null,
    });
  });

  test("applies a composed selection sequentially using the updated menu through the production factory", async () => {
    const initialEffort = option("effort", "low", ["low"], "thought_level");
    const wantedModel = { ...model, currentValue: "p/wanted" };
    const { calls, events, error } = await run(
      {
        configOptions: [initialEffort, model],
        responses: [{ configOptions: [effort, wantedModel] }],
      },
      { model: "logical-variant", modelConfigOptions: { effort: "high", family: "p/wanted" } },
      true,
    );
    expect(error).toBeNull();
    expect(calls.find((call) => call.method === "session/new")?.params).not.toHaveProperty("model");
    expect(
      calls
        .filter((call) => call.method === "session/set_config_option")
        .map((call) => call.params),
    ).toEqual([
      { sessionId: "fixture-session", configId: "family", value: "p/wanted" },
      { sessionId: "fixture-session", configId: "effort", value: "high" },
    ]);
    expect(selected(events)?.meta).toMatchObject({
      model: "logical-variant",
      config_options: { family: "p/wanted", effort: "high" },
      backend_model_uid: null,
    });
  });

  test("accepts grouped model values and explicit category-free IDs", async () => {
    const grouped = {
      ...model,
      category: undefined,
      options: [{ group: "models", name: "Models", options: model.options }],
    };
    const { calls, error } = await run(
      { configOptions: [grouped] },
      { model: "label", modelConfigOptions: { family: "p/wanted" } },
    );
    expect(error).toBeNull();
    expect(methods(calls)).toContain("session/set_config_option");
  });

  test("does not set an already-current advertised literal model", async () => {
    const { calls, error } = await run({ configOptions: [{ ...model, currentValue: "p/wanted" }] });
    expect(error).toBeNull();
    expect(methods(calls)).not.toContain("session/set_config_option");
  });

  test("ignores unrequested unsupported options and leaves unpinned sessions unchanged", async () => {
    const { calls, events, error } = await run(
      { configOptions: [{ id: "other", type: "future" }] },
      {},
    );
    expect(error).toBeNull();
    expect(methods(calls)).not.toContain("session/set_config_option");
    expect(selected(events)).toBeUndefined();
  });

  test("supports explicit config pins without a logical model label", async () => {
    const { events, error } = await run(
      { configOptions: [effort] },
      { modelConfigOptions: { effort: "high" } },
    );
    expect(error).toBeNull();
    expect(selected(events)?.meta).toMatchObject({
      config_options: { effort: "high" },
      backend_model_uid: null,
    });
  });

  test.each([
    ["empty list", []],
    ["malformed list", {}],
    ["unlisted value", [option("family", "p/default", ["p/default"], "model")]],
    ["ambiguous selectors", [model, option("other-model", "p/default", ["p/wanted"], "model")]],
    ["duplicate IDs", [model, model]],
    ["missing current value", [{ ...model, currentValue: undefined }]],
    ["unsupported selected option", [{ ...model, type: "future" }]],
    [
      "mixed grouped values",
      [
        {
          ...model,
          options: [...(model.options as unknown[]), { group: "g", name: "G", options: [] }],
        },
      ],
    ],
  ])("refuses %s before any prompt", async (_name, configOptions) => {
    const { calls, events, error } = await run({ configOptions });
    expect(methods(calls)).not.toContain("session/prompt");
    expect(error).not.toBeNull();
    expect(selected(events)).toBeUndefined();
  });

  test.each([
    ["missing configOptions", {}],
    ["wrong value", { configOptions: [model] }],
    ["missing requested selector", { configOptions: [effort] }],
    ["malformed acknowledgment", { configOptions: "p/wanted" }],
  ])("does not prompt when acknowledgment disagrees: %s", async (_name, ack) => {
    const { calls, events, error } = await run({ configOptions: [model], responses: [ack] });
    expect(methods(calls)).not.toContain("session/prompt");
    expect(error).not.toBeNull();
    expect(events.some((event) => event.kind === "acp.model_select_failed")).toBe(true);
    expect(selected(events)).toBeUndefined();
  });

  test("does not prompt when a later acknowledgment resets a previous pin", async () => {
    const { calls, error } = await run(
      {
        configOptions: [model, effort],
        responses: [
          { configOptions: [{ ...model, currentValue: "p/wanted" }, effort] },
          { configOptions: [model, { ...effort, currentValue: "high" }] },
        ],
      },
      { model: "variant", modelConfigOptions: { family: "p/wanted", effort: "high" } },
    );
    expect(methods(calls)).not.toContain("session/prompt");
    expect(error).not.toBeNull();
    expect(calls.filter((call) => call.method === "session/set_config_option")).toHaveLength(2);
  });

  test.each(["reject", "hang"])("refuses a %s config pin before any prompt", async (mode) => {
    const { calls, error } = await run({
      configOptions: [model],
      ...(mode === "reject" ? { rejectAt: 1 } : { hangAt: 1 }),
    });
    expect(methods(calls)).not.toContain("session/prompt");
    expect(error).toContain(mode === "reject" ? "fixture refused pin" : "boot timed out");
  });

  test("checks changed config pins on each fresh session of one warm process", async () => {
    const first = { model: "variant", modelConfigOptions: { family: "p/wanted", effort: "high" } };
    const second = {
      model: "variant",
      modelConfigOptions: { family: "p/default", effort: "high" },
    };
    const { calls, events, error } = await run({ configOptions: [model, effort] }, first, false, [
      second,
    ]);
    expect(error).toBeNull();
    expect(calls.filter((call) => call.method === "initialize")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/new")).toHaveLength(2);
    expect(
      events
        .filter((event) => event.kind === "acp.model_selected")
        .map((event) => event.meta?.config_options),
    ).toEqual([first.modelConfigOptions, second.modelConfigOptions]);
    expect(
      calls.filter((call) => call.method === "session/set_config_option").at(-1)?.params,
    ).toMatchObject({ sessionId: "fixture-session-2", configId: "effort", value: "high" });
  });

  test("refuses a rejected pin on a reused process without prompting that session", async () => {
    const first = { model: "variant", modelConfigOptions: { family: "p/wanted" } };
    const second = { model: "variant", modelConfigOptions: { family: "p/wanted", effort: "high" } };
    const { calls, events, error } = await run(
      { configOptions: [model, effort], rejectAt: 2 },
      first,
      false,
      [second],
    );
    expect(calls.filter((call) => call.method === "initialize")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "session/new")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "session/prompt")).toHaveLength(2);
    expect(
      calls
        .filter((call) => call.method === "session/prompt")
        .every((call) => call.params?.sessionId === "fixture-session"),
    ).toBe(true);
    expect(error).toContain("fixture refused pin");
    expect(events.filter((event) => event.kind === "acp.model_selected")).toHaveLength(1);
  });

  test("does not ignore an explicit map by falling back to the legacy model list", async () => {
    const { calls, error } = await run(
      { models: { currentModelId: "p/wanted", availableModels: [{ modelId: "p/wanted" }] } },
      { model: "p/wanted", modelConfigOptions: { effort: "high" } },
    );
    expect(methods(calls)).not.toContain("session/prompt");
    expect(error).not.toBeNull();
  });
});
