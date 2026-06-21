import type { RecallResult } from "@penumbra/core";

import { expect, test } from "bun:test";

import { connectInMemory, fakeDaemon, firstJson } from "./helpers.js";

interface RecallRequest {
  query: string;
  project_id?: string | null;
  limit?: number;
  session_id?: string;
  event_types?: string[];
  body_max_chars?: number;
  file_path?: string;
  min_score?: number;
  include_raw?: boolean;
}

interface RecallResponse {
  results: RecallResult[];
}

function makeHit(body: string): RecallResult {
  return {
    id: "r1",
    tier: "t1",
    score: 0.9,
    body,
    title: null,
    project_id: null,
    source_session_ids: ["s1"],
    created_at: "2026-04-23T12:00:00Z",
  } as unknown as RecallResult;
}

test("memory.recall forwards to daemon and returns results", async () => {
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  let receivedRequest: RecallRequest | undefined;
  const daemon = fakeDaemon({
    recall: (request: RecallRequest) => {
      receivedRequest = request;
      return Promise.resolve({ results: [makeHit("hit")] });
    },
  });
  const client = await connectInMemory(daemon);
  try {
    const out = await client.callTool({
      name: "memory_recall",
      arguments: { query: "anything", project_id: null, limit: 5 },
    });
    const payload = firstJson<RecallResponse>(out);
    expect(payload.results[0]?.id).toBe("r1");
    expect(receivedRequest?.query).toBe("anything");
  } finally {
    await client.close();
  }
});

test("memory.recall forwards session_id and event_types to daemon", async () => {
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  let receivedRequest: RecallRequest | undefined;
  const daemon = fakeDaemon({
    recall: (request: RecallRequest) => {
      receivedRequest = request;
      return Promise.resolve({ results: [] });
    },
  });
  const client = await connectInMemory(daemon);
  try {
    await client.callTool({
      name: "memory_recall",
      arguments: {
        query: "search",
        session_id: "sess-123",
        event_types: ["agent-thought"],
      },
    });
    expect(receivedRequest?.session_id).toBe("sess-123");
    expect(receivedRequest?.event_types).toEqual(["agent-thought"]);
  } finally {
    await client.close();
  }
});

test("memory.recall caps each body by default but honors explicit body_max_chars", async () => {
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  const daemon = fakeDaemon({
    recall: (_request: RecallRequest) => Promise.resolve({ results: [makeHit("x".repeat(1000))] }),
  });
  const client = await connectInMemory(daemon);
  try {
    const out = await client.callTool({
      name: "memory_recall",
      arguments: { query: "anything", project_id: null, limit: 5 },
    });
    const payload = firstJson<RecallResponse>(out);
    expect(payload.results[0]?.body).toHaveLength(600);

    const uncapped = await client.callTool({
      name: "memory_recall",
      arguments: { query: "anything", project_id: null, limit: 5, body_max_chars: 900 },
    });
    const uncappedPayload = firstJson<RecallResponse>(uncapped);
    expect(uncappedPayload.results[0]?.body).toHaveLength(900);
  } finally {
    await client.close();
  }
});

test("memory.recall body cap never splits a surrogate pair (emoji straddling the boundary)", async () => {
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  // Default cap is 600 chars; the emoji's two UTF-16 units occupy indices
  // 599-600, so a naive slice(0, 600) keeps a lone high surrogate.
  const body = "x".repeat(599) + "\u{1F600}" + "y".repeat(50);
  const daemon = fakeDaemon({
    recall: () => Promise.resolve({ results: [makeHit(body)] }),
  });
  const client = await connectInMemory(daemon);
  try {
    const out = await client.callTool({
      name: "memory_recall",
      arguments: { query: "anything", project_id: null, limit: 5 },
    });
    const payload = firstJson<RecallResponse>(out);
    const capped = payload.results[0]?.body ?? "";
    // Backed off one unit instead of keeping the lone high surrogate.
    expect(capped).toHaveLength(599);
    expect(capped.endsWith("x")).toBe(true);
    const lastCode = capped.charCodeAt(capped.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdfff).toBe(false);
  } finally {
    await client.close();
  }
});
