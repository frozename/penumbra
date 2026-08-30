import { FileTaskInputSchema } from "@penumbra/core";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskOutput, type TaskOutputCtx } from "@src/outputs/task.js";
import { WorkflowSpecSchema } from "@src/schema.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
type TaskBody = Record<string, unknown> & {
  prompt?: string;
  acceptance_criteria?: string;
  priority?: string;
  created_by_kind?: string;
  created_by_id?: string;
  origin?: string | null;
  eligibility?: { required_tags?: string[]; allow_agents?: string[]; min_tier?: string };
  review_eligibility?: { min_tier?: string };
  kind?: string;
  bounds?: { wall_clock_ms?: number; cost_cents?: number; max_sub_dispatches?: number };
};

function bodyString(init: FetchInit): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body === undefined || body === null) return "";
  // RequestInit body in tests is always a string here; stringify defensively
  // rather than triggering [object Object] coercion.
  return JSON.stringify(body);
}

function fetchAsString(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

test("task output schema parses minimal config and rejects missing prompt", () => {
  const parsed = WorkflowSpecSchema.parse({
    name: "task-wf",
    description: "file a task",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [{ kind: "task", prompt: "do the thing" }],
    run: { kind: "ts-function" },
  });
  expect(parsed.output[0]).toEqual({ kind: "task", prompt: "do the thing" });

  const missingPrompt = WorkflowSpecSchema.safeParse({
    name: "task-wf",
    description: "file a task",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [{ kind: "task" }],
    run: { kind: "ts-function" },
  });
  expect(missingPrompt.success).toBe(false);
});

test("taskOutput resolves templates and posts the workflow task payload", async () => {
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "task-out-"));
  writeFileSync(join(root, "port"), "54321");
  writeFileSync(join(root, "token"), "test-token");
  try {
    let captured: { url: string; init: FetchInit } | null = null;
    globalThis.fetch = ((input: FetchInput, init?: FetchInit) => {
      captured = { url: fetchAsString(input), init };
      return Promise.resolve(
        new Response(JSON.stringify({ task_id: "task-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;

    await taskOutput(
      {
        kind: "task",
        prompt: "investigate {{file_path}}",
        acceptance_criteria: "confirm {{file_path}} is fixed",
        priority: "high",
        eligibility: { required_tags: ["{{project}}"] },
        review_eligibility: { min_tier: "{{project}}" },
      },
      {
        workflow: { name: "task-wf", origin: undefined },
        now: (): Date => new Date("2026-05-05T08:00:00Z"),
        project: "penumbra",
        sessionStart: "2026-05-05T07:00:00Z",
        tz: "UTC",
        filePath: "src/foo.ts",
        storageRoot: root,
      } as TaskOutputCtx,
    );

    expect(captured).not.toBeNull();
    const captured1 = captured as unknown as { url: string; init: FetchInit };
    expect(captured1.url).toBe("http://127.0.0.1:54321/tasks");
    expect(captured1.init?.method).toBe("POST");
    const headers = captured1.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    const body = JSON.parse(bodyString(captured1.init)) as TaskBody;
    expect(body.prompt).toBe("investigate src/foo.ts");
    expect(body.acceptance_criteria).toBe("confirm src/foo.ts is fixed");
    expect(body.priority).toBe("high");
    expect(body.created_by_kind).toBe("workflow");
    expect(body.created_by_id).toBe("task-wf");
    expect("origin" in body).toBe(false);
    expect(body.eligibility?.required_tags).toEqual(["penumbra"]);
    expect(body.review_eligibility?.min_tier).toBe("penumbra");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("taskOutput passes through task_kind=orchestrate and bounds", async () => {
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "task-out-"));
  writeFileSync(join(root, "port"), "54321");
  writeFileSync(join(root, "token"), "test-token");
  try {
    let capturedBody: TaskBody | null = null;
    globalThis.fetch = ((_input: FetchInput, init?: FetchInit) => {
      capturedBody = JSON.parse(bodyString(init)) as TaskBody;
      return Promise.resolve(
        new Response(JSON.stringify({ task_id: "task-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;

    await taskOutput(
      {
        kind: "task",
        prompt: "orchestrate this",
        task_kind: "orchestrate",
        eligibility: { allow_agents: ["claude-acp-sonnet"] },
        bounds: { wall_clock_ms: 60_000, cost_cents: 50, max_sub_dispatches: 5 },
      },
      {
        workflow: { name: "task-wf", origin: undefined },
        now: (): Date => new Date("2026-05-05T08:00:00Z"),
        project: "penumbra",
        sessionStart: "2026-05-05T07:00:00Z",
        tz: "UTC",
        storageRoot: root,
      } as TaskOutputCtx,
    );

    const body = capturedBody as TaskBody | null;
    expect(body?.kind).toBe("orchestrate");
    expect(body?.bounds).toEqual({
      wall_clock_ms: 60_000,
      cost_cents: 50,
      max_sub_dispatches: 5,
    });
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("taskOutput omits kind/bounds when not specified", async () => {
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "task-out-"));
  writeFileSync(join(root, "port"), "54321");
  writeFileSync(join(root, "token"), "test-token");
  try {
    let capturedBody: TaskBody | null = null;
    globalThis.fetch = ((_input: FetchInput, init?: FetchInit) => {
      capturedBody = JSON.parse(bodyString(init)) as TaskBody;
      return Promise.resolve(
        new Response(JSON.stringify({ task_id: "task-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;

    await taskOutput({ kind: "task", prompt: "no orchestrate" }, {
      workflow: { name: "task-wf", origin: undefined },
      now: (): Date => new Date("2026-05-05T08:00:00Z"),
      project: "penumbra",
      sessionStart: "2026-05-05T07:00:00Z",
      tz: "UTC",
      storageRoot: root,
    } as TaskOutputCtx);

    const body = capturedBody as TaskBody | null;
    expect(body?.kind).toBeUndefined();
    expect(body?.bounds).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("taskOutput wire body satisfies FileTaskInputSchema when origin is unset", async () => {
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "task-out-"));
  writeFileSync(join(root, "port"), "54321");
  writeFileSync(join(root, "token"), "test-token");
  try {
    let capturedBody: unknown = null;
    globalThis.fetch = ((_input: FetchInput, init?: FetchInit) => {
      capturedBody = JSON.parse(bodyString(init));
      return Promise.resolve(
        new Response(JSON.stringify({ task_id: "task-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;

    await taskOutput({ kind: "task", prompt: "do the thing" }, {
      workflow: { name: "task-wf", origin: undefined },
      now: (): Date => new Date("2026-05-05T08:00:00Z"),
      project: "penumbra",
      sessionStart: "2026-05-05T07:00:00Z",
      tz: "UTC",
      storageRoot: root,
    } as TaskOutputCtx);

    const parsed = FileTaskInputSchema.safeParse(capturedBody);
    expect(parsed.success).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("taskOutput propagates workflow origin", async () => {
  const realFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "task-out-"));
  writeFileSync(join(root, "port"), "54321");
  writeFileSync(join(root, "token"), "test-token");
  try {
    let capturedBody: TaskBody | null = null;
    globalThis.fetch = ((_input: FetchInput, init?: FetchInit) => {
      capturedBody = JSON.parse(bodyString(init)) as TaskBody;
      return Promise.resolve(
        new Response(JSON.stringify({ task_id: "task-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;

    await taskOutput(
      { kind: "task", prompt: "do it" },
      {
        workflow: { name: "task-wf", origin: "wf-test" },
        now: (): Date => new Date("2026-05-05T08:00:00Z"),
        project: "penumbra",
        sessionStart: "2026-05-05T07:00:00Z",
        tz: "UTC",
        storageRoot: root,
      },
    );

    const body = capturedBody as TaskBody | null;
    expect(body?.origin).toBe("wf-test");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
