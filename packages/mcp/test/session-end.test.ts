import { expect, test } from "bun:test";

import { DaemonClient } from "../src/daemon-client.js";
import { connectInMemory, firstJson } from "./helpers.js";

test("session.end forwards to daemon", async () => {
  let body: unknown = null;
  let receivedMethod: string | undefined;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      receivedMethod = req.method;
      body = await req.json();
      return Response.json({ ok: true, rollup_id: "r1" });
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
      name: "session_end",
      arguments: { session_id: "sX" },
    });
    const payload = firstJson<{ rollup_id: string }>(out);
    expect(payload.rollup_id).toBe("r1");
    expect(body).toEqual({ session_id: "sX" });
    expect(receivedMethod).toBe("POST");
  } finally {
    await client?.close();
    srv.stop(true);
  }
});
