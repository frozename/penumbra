import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { createDaemonFetchHandler, serve } from "../src/serve.js";
import { serviceTest } from "./helpers/service-gates.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

afterEach(() => {
  delete process.env.PENUMBRA_DAEMON_HOST;
  delete process.env.PENUMBRA_JUDGE_BASE_URL;
  delete process.env.PENUMBRA_REFINER_MODEL;
  mock.restore();
});

function makeServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
}

serviceTest("serve binds to 127.0.0.1 by default", async () => {
  const services = makeServices();
  const stop = spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);

  const handle = serve({ services, token: "test-token", port: 0 });
  try {
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${String(handle.port)}/health`);
    expect(res.status).toBe(200);
  } finally {
    await handle.stop();
    expect(stop).toHaveBeenCalled();
    services.db.close();
  }
});

serviceTest("serve honors PENUMBRA_DAEMON_HOST override", async () => {
  process.env.PENUMBRA_DAEMON_HOST = "0.0.0.0";
  const services = makeServices();
  const stop = spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);

  const handle = serve({ services, token: "test-token", port: 0 });
  try {
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${String(handle.port)}/health`);
    expect(res.status).toBe(200);
  } finally {
    await handle.stop();
    expect(stop).toHaveBeenCalled();
    services.db.close();
  }
});

serviceTest("serve installs global crash handlers once", async () => {
  const services = makeServices();
  const stop = spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);

  const baselineUnhandled = process.listenerCount("unhandledRejection");
  const baselineUncaught = process.listenerCount("uncaughtException");

  const handle1 = serve({ services, token: "test-token", port: 0 });
  const afterFirstUnhandled = process.listenerCount("unhandledRejection");
  const afterFirstUncaught = process.listenerCount("uncaughtException");
  const handle2 = serve({ services, token: "test-token", port: 0 });

  try {
    expect(afterFirstUnhandled).toBeGreaterThanOrEqual(baselineUnhandled + 1);
    expect(afterFirstUncaught).toBeGreaterThanOrEqual(baselineUncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(afterFirstUnhandled);
    expect(process.listenerCount("uncaughtException")).toBe(afterFirstUncaught);
  } finally {
    await handle1.stop();
    await handle2.stop();
    expect(stop).toHaveBeenCalled();
    services.db.close();
  }
});

test("serve leaves process signal handling to direct embedders by default", async () => {
  const services = makeServices();
  spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);

  const baselineSigterm = process.listenerCount("SIGTERM");
  const baselineSigint = process.listenerCount("SIGINT");
  const handle = serve({ services, token: "test-token", port: 0 });

  try {
    expect(process.listenerCount("SIGTERM")).toBe(baselineSigterm);
    expect(process.listenerCount("SIGINT")).toBe(baselineSigint);
  } finally {
    await handle.stop();
    services.db.close();
  }
});

test("dispatch refiner fails over from a dead role-resolved local seat and records health", async () => {
  process.env.PENUMBRA_JUDGE_BASE_URL = "http://127.0.0.1:7944";
  process.env.PENUMBRA_REFINER_MODEL = "lfm2-generator";
  const services = makeServices();
  services.agentchatConfig = {
    agents: [
      {
        name: "refiner-local-dead",
        adapter: "openai-compat-http",
        roles: ["refiner"],
        options: { baseUrl: "http://127.0.0.1:7944/v1", model: "retired-local" },
      },
      {
        name: "refiner-sakana-healthy",
        adapter: "openai-compat-http",
        roles: ["refiner"],
        pricing_mode: "subscription",
        subscription_provider: "sakana",
        options: {
          baseUrl: "https://api.sakana.ai/v1",
          model: "sakana-rewriter",
          provider: "sakana",
          apiKey: "role-sakana-token",
        },
      },
    ],
  };
  const fetchMock = mock(
    (url: string): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: url.startsWith("http://127.0.0.1:7944")
                    ? ""
                    : "Implement the requested change. Keep the scope narrow.",
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
  );
  const handler = createDaemonFetchHandler({
    services,
    token: "test-token",
    allowRemote: true,
    llmFetchFn: fetchMock as unknown as typeof fetch,
  });

  try {
    const response = await handler(
      new Request("http://localhost/dispatch/refine", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "Original dispatch prompt" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      refined: "Implement the requested change. Keep the scope narrow.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, fallbackInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(fallbackInit.headers).toMatchObject({
      authorization: "Bearer role-sakana-token",
    });
    const health = services.db
      .query<{ tier: string; seat: string; model: string; host: string }, []>(
        `SELECT tier, seat, model, host
         FROM subsystem_health
         WHERE subsystem = 'dispatch.refiner'`,
      )
      .get();
    expect(health).toEqual({
      tier: "fallback",
      seat: "refiner-sakana-healthy",
      model: "sakana-rewriter",
      host: "api.sakana.ai",
    });
  } finally {
    services.supervisor.stopAll();
    services.db.close();
  }
});
