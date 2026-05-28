import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emitObservationOutput } from "../../src/outputs/observation.js";

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
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({ event_id: "evt-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const summaryBody = "A".repeat(500);
    const r = await withMockedFetch(fakeFetch, () =>
      emitObservationOutput({
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
    expect(captured!.url).toBe("http://127.0.0.1:54321/observations");
    expect(captured!.init?.method).toBe("POST");
    const headers = captured!.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-token");
    const body = JSON.parse(String(captured!.init?.body));
    expect(body.source).toBe("agentchat");
    expect(body.source_detail).toBe("workflow:session-summarize");
    expect(body.event_type).toBe("agent-response");
    expect(body.lane).toBe("unknown");
    expect(body.project_id).toBe("penumbra");
    expect(body.session_id).toBe("sess-abc");
    expect(body.payload_summary.length).toBe(240);
    expect(body.payload_summary).toBe("A".repeat(240));
    expect(body.payload_json.full_summary).toBe(summaryBody);
    expect(body.payload_json.workflow_name).toBe("session-summarize");
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
    const fakeFetch: typeof globalThis.fetch = async () => new Response("error", { status: 500 });
    const r = await withMockedFetch(fakeFetch, () =>
      emitObservationOutput({
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
    let captured: any = null;
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ event_id: "e" }), { status: 200 });
    };
    await withMockedFetch(fakeFetch, () =>
      emitObservationOutput({
        body: "b",
        storageRoot: root,
        workflowName: "wf",
        project: "unknown",
      }),
    );
    expect(captured.project_id).toBeNull();
    expect(captured.payload_json.project_id).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
