import { applySchema, buildServices, loadSqliteVec, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

import { createDaemonFetchHandler } from "../../src/serve.js";

const OTLP_PATHS = ["/v1/logs", "/v1/metrics", "/v1/traces"] as const;
const TOKEN = "tok";

function createTestHandler(hostname?: string): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/daemon-otlp-auth-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
  const handler = createDaemonFetchHandler({ services, token: TOKEN, hostname });
  return {
    fetch: (path, init): Promise<Response> => handler(new Request(`http://x${path}`, init)),
    services,
    stop: (): void => {
      services.supervisor.stopAll();
      db.close();
    },
  };
}

function otlpBody(path: string): string {
  if (path === "/v1/metrics") return '{"resourceMetrics":[]}';
  if (path === "/v1/traces") return '{"resourceSpans":[]}';
  return '{"resourceLogs":[]}';
}

const loopback = createTestHandler("127.0.0.1");
const exposed = createTestHandler("0.0.0.0");

afterAll(() => {
  loopback.stop();
  exposed.stop();
});

test("loopback-bound daemon accepts OTLP ingest without a bearer token", async () => {
  for (const path of OTLP_PATHS) {
    const res = await loopback.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: otlpBody(path),
    });
    expect(res.status).toBe(200);
  }
});

test("non-loopback-bound daemon rejects unauthenticated OTLP ingest", async () => {
  for (const path of OTLP_PATHS) {
    const res = await exposed.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: otlpBody(path),
    });
    expect(res.status).toBe(401);
  }
});

test("non-loopback-bound daemon accepts OTLP ingest with the daemon token", async () => {
  for (const path of OTLP_PATHS) {
    const res = await exposed.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: otlpBody(path),
    });
    expect(res.status).toBe(200);
  }
});
