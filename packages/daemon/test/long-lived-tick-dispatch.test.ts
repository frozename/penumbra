import { afterEach, expect, mock, spyOn } from "bun:test";
import { serviceTest } from "./helpers/service-gates.js";
import { Database } from "bun:sqlite";
import { BundledEmbedder, buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import * as chainRoutes from "../src/routes/chains.js";
import { serve } from "../src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

afterEach(() => {
  mock.restore();
});

function makeServices(projectId?: string | undefined) {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp",
    db,
    embedder: new BundledEmbedder(),
  });

  const longLivedConfig = {
    schedule_cron: "*/5 * * * *",
    subscriptions: [],
    mcp_allowlist: [],
    bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
    circuit_breaker_threshold: 3,
    standing_brief: "watch sensors",
    ...(projectId !== undefined ? { project_id: projectId } : {}),
  };

  (services as any).agentchatConfig = {
    agents: [
      {
        name: "home",
        long_lived: true,
        display_name: "Home Monitor",
        long_lived_config: longLivedConfig,
      },
    ],
  };

  const handle = serve({ services, token: "test-token", port: 0 });

  return { db, services, handle };
}

serviceTest("long-lived tick dispatch uses configured project_id", async () => {
  const chainStartMock = mock((input: any, _services: any) =>
    Promise.resolve(
      new Response(JSON.stringify({ conversation_id: "conv-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  spyOn(chainRoutes, "chainStartInternal").mockImplementation(chainStartMock);

  const { db, services, handle } = makeServices("llamactl");
  try {
    await services.longLivedReactor?.reload();
    const result = services.longLivedReactor?.manualTick("home");
    expect(result?.outcome).toBe("spawned");
    await Bun.sleep(20);

    expect(chainStartMock).toHaveBeenCalledTimes(1);
    expect(chainStartMock.mock.calls[0]?.[0]?.project_id).toBe("llamactl");
  } finally {
    handle.stop();
    db.close();
  }
});

serviceTest("long-lived tick dispatch falls back to penumbra when project_id is null", async () => {
  const chainStartMock = mock((input: any, _services: any) =>
    Promise.resolve(
      new Response(JSON.stringify({ conversation_id: "conv-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  spyOn(chainRoutes, "chainStartInternal").mockImplementation(chainStartMock);

  const { db, services, handle } = makeServices();
  try {
    await services.longLivedReactor?.reload();
    const result = services.longLivedReactor?.manualTick("home");
    expect(result?.outcome).toBe("spawned");
    await Bun.sleep(20);

    expect(chainStartMock).toHaveBeenCalledTimes(1);
    expect(chainStartMock.mock.calls[0]?.[0]?.project_id).toBe("penumbra");
  } finally {
    handle.stop();
    db.close();
  }
});
