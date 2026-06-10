import { expect, test } from "bun:test";
import { connectInMemory } from "./helpers.js";

test("memory.recall forwards to daemon and returns results", async () => {
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  let receivedRequest: any;
  const daemon = {
    recall: async (request: any) => {
      receivedRequest = request;
      return {
        results: [
          {
            id: "r1",
            tier: "t1",
            score: 0.9,
            body: "hit",
            title: null,
            project_id: null,
            source_session_ids: ["s1"],
            created_at: "2026-04-23T12:00:00Z",
          },
        ],
      };
    },
  } as any;
  const client = await connectInMemory(daemon);
  try {
    const out = await client.callTool({
      name: "memory_recall",
      arguments: { query: "anything", project_id: null, limit: 5 },
    });
    const content = (out as unknown as { content: { type: string; text: string }[] }).content;
    const payload = JSON.parse(content[0]!.text);
    expect(payload.results[0].id).toBe("r1");
    expect(receivedRequest.query).toBe("anything");
  } finally {
    await client.close();
  }
});

test("memory.recall forwards session_id and event_types to daemon", async () => {
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  let receivedRequest: any;
  const daemon = {
    recall: async (request: any) => {
      receivedRequest = request;
      return { results: [] };
    },
  } as any;
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
    expect(receivedRequest.session_id).toBe("sess-123");
    expect(receivedRequest.event_types).toEqual(["agent-thought"]);
  } finally {
    await client.close();
  }
});

test("memory.recall caps each body by default but honors explicit body_max_chars", async () => {
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  let receivedRequest: any;
  const daemon = {
    recall: async (request: any) => {
      receivedRequest = request;
      return {
        results: [
          {
            id: "r1",
            tier: "t1",
            score: 0.9,
            body: "x".repeat(1000),
            title: null,
            project_id: null,
            source_session_ids: ["s1"],
            created_at: "2026-04-23T12:00:00Z",
          },
        ],
      };
    },
  } as any;
  const client = await connectInMemory(daemon);
  try {
    const out = await client.callTool({
      name: "memory_recall",
      arguments: { query: "anything", project_id: null, limit: 5 },
    });
    const payload = JSON.parse(
      (out as unknown as { content: { type: string; text: string }[] }).content[0]!.text,
    );
    expect(payload.results[0].body).toHaveLength(600);

    const uncapped = await client.callTool({
      name: "memory_recall",
      arguments: { query: "anything", project_id: null, limit: 5, body_max_chars: 900 },
    });
    const uncappedPayload = JSON.parse(
      (uncapped as unknown as { content: { type: string; text: string }[] }).content[0]!.text,
    );
    expect(uncappedPayload.results[0].body).toHaveLength(900);
  } finally {
    await client.close();
  }
});

test("memory.recall body cap never splits a surrogate pair (emoji straddling the boundary)", async () => {
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  // Default cap is 600 chars; the emoji's two UTF-16 units occupy indices
  // 599-600, so a naive slice(0, 600) keeps a lone high surrogate.
  const body = "x".repeat(599) + "\u{1F600}" + "y".repeat(50);
  const daemon = {
    recall: async () => ({
      results: [
        {
          id: "r1",
          tier: "t1",
          score: 0.9,
          body,
          title: null,
          project_id: null,
          source_session_ids: ["s1"],
          created_at: "2026-04-23T12:00:00Z",
        },
      ],
    }),
  } as any;
  const client = await connectInMemory(daemon);
  try {
    const out = await client.callTool({
      name: "memory_recall",
      arguments: { query: "anything", project_id: null, limit: 5 },
    });
    const payload = JSON.parse(
      (out as unknown as { content: { type: string; text: string }[] }).content[0]!.text,
    );
    const capped: string = payload.results[0].body;
    // Backed off one unit instead of keeping the lone high surrogate.
    expect(capped).toHaveLength(599);
    expect(capped.endsWith("x")).toBe(true);
    const lastCode = capped.charCodeAt(capped.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdfff).toBe(false);
  } finally {
    await client.close();
  }
});
