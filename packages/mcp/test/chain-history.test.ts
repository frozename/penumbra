import { expect, test } from "bun:test";
import { z } from "zod";

import { DaemonClient } from "../src/daemon-client.js";
import { connectInMemory } from "./helpers.js";

test("chain.history forwards to daemon and returns results", async () => {
  let receivedPath: string | undefined;
  let receivedMethod: string | undefined;
  let receivedQuery: string | undefined;

  const mockHistory = [
    {
      ts: "2026-04-27T01:48:00Z",
      reason: "max_hops reached",
      hop_count: 5,
      terminal_handoff_id: "h1",
      conversation_id: "c1",
    },
  ];

  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      receivedPath = url.pathname;
      receivedMethod = req.method;
      receivedQuery = url.search;
      return Response.json({ history: mockHistory });
    },
  }) as unknown as { port: number; stop(closeActiveConnections?: boolean): void };

  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({
      baseUrl: `http://localhost:${String(srv.port)}`,
      token: "t",
    });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: "chain_history",
      arguments: { conversation_id: "c1" },
    });
    const parsed = z
      .object({
        content: z.array(z.object({ type: z.string(), text: z.string() })).min(1),
      })
      .parse(out);
    const history = JSON.parse(parsed.content[0]!.text) as unknown;

    expect(history).toEqual(mockHistory);
    expect(receivedPath).toBe("/chains/history");
    expect(receivedMethod).toBe("GET");
    expect(receivedQuery).toContain("conversation_id=c1");
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
