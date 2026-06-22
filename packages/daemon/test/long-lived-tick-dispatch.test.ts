import {
  buildServices,
  BundledEmbedder,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, spyOn } from "bun:test";

import * as chainRoutes from "../src/routes/chains.js";
import { serve } from "../src/serve.js";
import { serviceTest } from "./helpers/service-gates.js";

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

type ChainStartInternalArgs = Parameters<typeof chainRoutes.chainStartInternal>;
type ChainStartInternalInput = ChainStartInternalArgs[0];
type ChainStartInternalReturn = ReturnType<typeof chainRoutes.chainStartInternal>;

interface MakeServicesResult {
  db: Database;
  services: Services;
  handle: ReturnType<typeof serve>;
}

// Services["agentchatConfig"] is a narrow snapshot of agents.yaml that omits
// the `long_lived` / `long_lived_config` / `display_name` fields the
// long-lived reactor consumes at tick time. The reactor reads via a
// closure over services.agentchatConfig, so a structural assignment from
// an intermediate variable is enough to bypass the excess-property check.
function installLongLivedAgent(
  services: Services,
  agent: {
    name: string;
    display_name: string;
    long_lived: boolean;
    long_lived_config: Record<string, unknown>;
  },
): void {
  const config = { agents: [{ ...agent, roles: [] }] };
  services.agentchatConfig = config;
}

function makeServices(projectId?: string): MakeServicesResult {
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

  const longLivedConfig: Record<string, unknown> = {
    schedule_cron: "*/5 * * * *",
    subscriptions: [],
    mcp_allowlist: [],
    bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
    circuit_breaker_threshold: 3,
    standing_brief: "watch sensors",
    ...(projectId !== undefined ? { project_id: projectId } : {}),
  };

  installLongLivedAgent(services, {
    name: "home",
    long_lived: true,
    display_name: "Home Monitor",
    long_lived_config: longLivedConfig,
  });

  const handle = serve({ services, token: "test-token", port: 0 });

  return { db, services, handle };
}

serviceTest("long-lived tick dispatch uses configured project_id", async () => {
  const chainStartMock = mock(
    (
      _input: ChainStartInternalInput,
      _services: ChainStartInternalArgs[1],
    ): ChainStartInternalReturn =>
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
    const firstCall = chainStartMock.mock.calls[0]?.[0];
    expect(firstCall?.project_id).toBe("llamactl");
  } finally {
    await handle.stop();
    db.close();
  }
});

serviceTest("long-lived tick dispatch falls back to penumbra when project_id is null", async () => {
  const chainStartMock = mock(
    (
      _input: ChainStartInternalInput,
      _services: ChainStartInternalArgs[1],
    ): ChainStartInternalReturn =>
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
    const firstCall = chainStartMock.mock.calls[0]?.[0];
    expect(firstCall?.project_id).toBe("penumbra");
  } finally {
    await handle.stop();
    db.close();
  }
});
