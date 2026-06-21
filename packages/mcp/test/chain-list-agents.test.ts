import { expect, test } from "bun:test";
import { z } from "zod";

import { DaemonClient } from "../src/daemon-client.js";
import { connectInMemory } from "./helpers.js";

test("chain.list_agents forwards to daemon and returns results", async () => {
  let receivedPath: string | undefined;
  let receivedMethod: string | undefined;

  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      receivedPath = url.pathname;
      receivedMethod = req.method;
      return Response.json({ agents: [{ name: "planner" }, { name: "executor" }] });
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
      name: "chain_list_agents",
      arguments: {},
    });
    const parsed = z
      .object({
        content: z.array(z.object({ type: z.string(), text: z.string() })).min(1),
      })
      .parse(out);

    expect(JSON.parse(parsed.content[0]!.text) as unknown).toEqual({
      agents: [{ name: "planner" }, { name: "executor" }],
    });
    expect(receivedPath).toBe("/chains/agents");
    expect(receivedMethod).toBe("GET");
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
