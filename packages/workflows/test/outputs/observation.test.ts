import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitObservationOutput } from "@src/outputs/observation.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

type ObservationBody = {
  source?: string;
  source_detail?: string;
  event_type?: string;
  lane?: string;
  project_id?: string | null;
  session_id?: string | null;
  payload_summary?: string;
  payload_json?: { workflow_name?: string; full_summary?: string; project_id?: string | null };
  ts?: string;
};

function bodyString(init: FetchInit): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  return "";
}

function fetchAsString(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const realFetch = globalThis.fetch;

function withMockedFetch<T>(impl: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = realFetch;
  });
}

function makeStorageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "obs-out-"));
  writeFileSync(join(root, "port"), "54321");
  writeFileSync(join(root, "token"), "test-token");
  return root;
}

test("emitObservationOutput POSTs to /observations with the expected payload shape", async () => {
  const root = makeStorageRoot();
  try {
    let captured: { url: string; init: FetchInit } | null = null;
    const fakeFetch: typeof globalThis.fetch = (input: FetchInput, init?: FetchInit) => {
      captured = { url: fetchAsString(input), init };
      return Promise.resolve(
        new Response(JSON.stringify({ event_id: "evt-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const summaryBody = "A".repeat(500);
    const r = await withMockedFetch(
      fakeFetch,
      async () =>
        await emitObservationOutput({
          body: summaryBody,
          storageRoot: root,
          workflowName: "session-summarize",
          project: "penumbra",
          sessionId: "sess-abc",
          ts: "2026-05-05T08:00:00Z",
        }),
    );
    expect(r.warnings).toEqual([]);
    expect(r.eventId).toBe("evt-1");
    expect(captured).not.toBeNull();
    const captured1 = captured as unknown as { url: string; init: FetchInit };
    expect(captured1.url).toBe("http://127.0.0.1:54321/observations");
    expect(captured1.init?.method).toBe("POST");
    const headers = captured1.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-token");
    const body = JSON.parse(bodyString(captured1.init)) as ObservationBody;
    expect(body.source).toBe("agentchat");
    expect(body.source_detail).toBe("workflow:session-summarize");
    expect(body.event_type).toBe("agent-response");
    expect(body.lane).toBe("unknown");
    expect(body.project_id).toBe("penumbra");
    expect(body.session_id).toBe("sess-abc");
    expect(body.payload_summary?.length).toBe(240);
    expect(body.payload_summary).toBe("A".repeat(240));
    expect(body.payload_json?.full_summary).toBe(summaryBody);
    expect(body.payload_json?.workflow_name).toBe("session-summarize");
    expect(body.ts).toBe("2026-05-05T08:00:00Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitObservationOutput returns warning when daemon files are missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "obs-out-empty-"));
  try {
    const r = await emitObservationOutput({
      body: "x",
      storageRoot: root,
      workflowName: "session-summarize",
    });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("daemon port/token not found");
    expect(r.eventId).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitObservationOutput surfaces non-200 response as warning", async () => {
  const root = makeStorageRoot();
  try {
    const fakeFetch: typeof globalThis.fetch = () =>
      Promise.resolve(new Response("error", { status: 500 }));
    const r = await withMockedFetch(
      fakeFetch,
      async () =>
        await emitObservationOutput({
          body: "x",
          storageRoot: root,
          workflowName: "wf",
        }),
    );
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("500");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('emitObservationOutput sends null project_id when project is "unknown" or empty', async () => {
  const root = makeStorageRoot();
  try {
    let captured: ObservationBody | null = null;
    const fakeFetch: typeof globalThis.fetch = (_input: FetchInput, init?: FetchInit) => {
      captured = JSON.parse(bodyString(init)) as ObservationBody;
      return Promise.resolve(new Response(JSON.stringify({ event_id: "e" }), { status: 200 }));
    };
    await withMockedFetch(
      fakeFetch,
      async () =>
        await emitObservationOutput({
          body: "b",
          storageRoot: root,
          workflowName: "wf",
          project: "unknown",
        }),
    );
    const body = captured as ObservationBody | null;
    expect(body?.project_id).toBeNull();
    expect(body?.payload_json?.project_id).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
