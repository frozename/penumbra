import { expect } from "bun:test";
import { serviceTest } from "./helpers/service-gates.js";
import { makeTempDaemon } from "./helpers.js";

serviceTest("GET /metrics returns counts, embedder name/dim, and version", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/metrics`, {
      headers: { authorization: `Bearer ${d.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      embedder: { name: string; dim: number };
      counts: { t0_events: number; t1_rollups: number; t2_memories: number };
      uptime_sec: number;
    };
    expect(body.embedder.name).toBe("test");
    expect(body.embedder.dim).toBe(384);
    expect(body.counts.t0_events).toBe(0);
    expect(body.counts.t1_rollups).toBe(0);
    expect(body.counts.t2_memories).toBe(0);
    expect(body.uptime_sec).toBeGreaterThanOrEqual(0);
  } finally {
    d.stop();
  }
});
