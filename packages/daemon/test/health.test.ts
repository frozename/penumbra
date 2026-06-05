import { expect } from "bun:test";
import { serviceTest } from "./helpers/service-gates.js";
import { makeTempDaemon } from "./helpers.js";

serviceTest("GET /health returns 200", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
  } finally {
    d.stop();
  }
});

serviceTest("GET /health needs no auth", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/health`);
    expect(res.status).toBe(200);
  } finally {
    d.stop();
  }
});

serviceTest("GET /other returns 401 without token", async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/observations`, { method: "POST" });
    expect(res.status).toBe(401);
  } finally {
    d.stop();
  }
});
