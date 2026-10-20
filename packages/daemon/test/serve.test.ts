import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonFetchHandler, serve } from "../src/serve.js";
import { serviceTest } from "./helpers/service-gates.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.PENUMBRA_DAEMON_HOST;
  delete process.env.PENUMBRA_JUDGE_BASE_URL;
  delete process.env.PENUMBRA_REFINER_MODEL;
  mock.restore();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  // mainRepoDir + worktreeRootDir point into a per-test mkdtemp so the
  // scratch service can never resolve the real checkout's fleet base.
  const root = mkdtempSync(join(tmpdir(), "penumbra-serve-test-"));
  tempDirs.push(root);
  return buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    mainRepoDir: root,
    worktreeRootDir: join(root, "worktrees"),
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

test("evaluateStartupLlmRoleFloors stores role floor state for health responses", async () => {
  const services = makeServices();
  let fetchHandler: ((req: Request) => Response | Promise<Response>) | undefined;
  const serverStop = mock(() => undefined);
  spyOn(Bun, "serve").mockImplementation((opts) => {
    fetchHandler = opts.fetch as typeof fetchHandler;
    return { port: 65530, stop: serverStop } as unknown as ReturnType<typeof Bun.serve>;
  });
  services.agentchatConfig = {
    agents: [
      { name: "brief-synthesizer-1", roles: ["brief-synthesizer"] },
      { name: "memory-refiner-1", roles: ["memory-refiner"] },
      { name: "dreaming-judge-1", roles: ["dreaming-judge"] },
      { name: "dreaming-judge-2", roles: ["dreaming-judge"] },
      { name: "dreaming-rewriter-1", roles: ["dreaming-rewriter"] },
      { name: "refiner-1", roles: ["refiner"] },
    ],
  };
  spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);

  const handle = serve({ services, token: "test-token", port: 0 });
  try {
    expect(fetchHandler).toBeFunction();
    const res = await fetchHandler!(new Request("http://127.0.0.1/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.llmRoleFloors).toEqual({ ok: true, violations: [] });
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

test("serve does not run the boot scratch sweep unless explicitly opted in", async () => {
  // A second daemon instance must never reap a production daemon's live
  // scratch worktrees: the boot sweep is opt-in (packages/cli start only).
  const services = makeServices();
  spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);
  const sweep = spyOn(services.scratchWorktrees, "sweepOrphans").mockResolvedValue({
    reaped: [],
    kept: [],
    deferred: [],
  });
  const handle = serve({ services, token: "test-token", port: 0 });
  try {
    await Bun.sleep(0);
    expect(sweep).not.toHaveBeenCalled();
  } finally {
    await handle.stop();
    services.db.close();
  }
});

test("serve runs the boot scratch sweep when bootScratchSweep is set", async () => {
  const services = makeServices();
  spyOn(services.supervisor, "stopAll").mockImplementation(() => undefined);
  spyOn(services.supervisor, "startAll").mockResolvedValue(undefined);
  const sweep = spyOn(services.scratchWorktrees, "sweepOrphans").mockResolvedValue({
    reaped: [],
    kept: [],
    deferred: [],
  });
  const handle = serve({ services, token: "test-token", port: 0, bootScratchSweep: true });
  try {
    await Bun.sleep(0);
    expect(sweep).toHaveBeenCalledTimes(1);
  } finally {
    await handle.stop();
    services.db.close();
  }
});
