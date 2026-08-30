import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { conversationsCancelRoute } from "@penumbra/daemon/routes/conversations";
import {
  handoffsApproveRoute,
  handoffsCompleteRoute,
  handoffsCreateRoute,
  handoffsGetRoute,
} from "@penumbra/daemon/routes/handoffs";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { DaemonClient } from "../src/daemon-client.js";
import { connectInMemory, fakeDaemon, firstJson, firstText } from "./helpers.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/mcp-chain-cancel-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-27T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return (): string => `h-${String(++n)}`;
    })(),
  });
}

async function createHandoff(services: Services, conversation_id: string): Promise<string> {
  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "user",
        to: "agent",
        message: "go",
        conversation_id,
        triggered_by_event_id: "evt-1",
      }),
    }),
    services,
  );
  const body = (await res.json()) as { handoff_id: string };
  return body.handoff_id;
}

interface ServeHandle {
  port: number;
  stop(closeActiveConnections?: boolean): void;
}

function startDaemon(services: Services): ServeHandle {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.startsWith("/handoffs/")) {
        const handoff_id = decodeURIComponent(url.pathname.slice("/handoffs/".length));
        return await Promise.resolve(handoffsGetRoute(req, handoff_id, services));
      }

      const cancelMatch = /^\/conversations\/([^/]+)\/cancel$/.exec(url.pathname);
      if (req.method === "POST" && cancelMatch) {
        return await Promise.resolve(
          conversationsCancelRoute(req, decodeURIComponent(cancelMatch[1]!), services),
        );
      }

      return Response.json(
        { error: { code: "not_found", message: "route not found" } },
        { status: 404 },
      );
    },
  }) as unknown as ServeHandle;
}

test("chain.cancel on a dispatched handoff returns cancel_requested and persists cancel_requested_at", async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, "conv-dispatched");
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${handoff_id}/approve`, { method: "POST", body: "{}" }),
    handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(handoff_id, "worker-1");

  const srv = startDaemon(services);
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({
      baseUrl: `http://localhost:${String(srv.port)}`,
      token: "t",
    });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: "chain_cancel",
      arguments: { handoff_id },
    });
    const parsed = firstJson(out);

    expect(parsed).toEqual({ status: "cancel_requested", current_status: "dispatched" });
    expect(services.handoffReader.get(handoff_id)?.cancel_requested_at).toBe(
      "2026-04-27T00:00:00.000Z",
    );
  } finally {
    await client?.close();
    srv.stop(true);
  }
});

test("complete after chain.cancel marks the handoff failed instead of completed", async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, "conv-cancel-complete");
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${handoff_id}/approve`, { method: "POST", body: "{}" }),
    handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(handoff_id, "worker-1");

  conversationsCancelRoute(
    new Request("http://x/conversations/conv-cancel-complete/cancel", { method: "POST" }),
    "conv-cancel-complete",
    services,
  );
  const res = await handoffsCompleteRoute(
    new Request(`http://x/handoffs/${handoff_id}/complete`, { method: "POST" }),
    handoff_id,
    services,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ handoff_id, status: "failed", reason: "cancelled" });

  const row = services.handoffReader.get(handoff_id);
  expect(row?.status).toBe("failed");
  expect(row?.resolution_reason).toBe("cancelled");
  expect(row?.resolved_by).toBe("cancel");
  expect(row?.resolved_at).toBe("2026-04-27T00:00:00.000Z");
});

test("chain.cancel on a completed handoff returns already_terminal", async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, "conv-completed");
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${handoff_id}/approve`, { method: "POST", body: "{}" }),
    handoff_id,
    services,
  );
  services.handoffWriter.claimDispatch(handoff_id, "worker-1");
  await handoffsCompleteRoute(
    new Request(`http://x/handoffs/${handoff_id}/complete`, { method: "POST" }),
    handoff_id,
    services,
  );

  const srv = startDaemon(services);
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({
      baseUrl: `http://localhost:${String(srv.port)}`,
      token: "t",
    });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: "chain_cancel",
      arguments: { handoff_id },
    });
    const parsed = firstJson(out);

    expect(parsed).toEqual({ status: "already_terminal", current_status: "completed" });
    expect(services.handoffReader.get(handoff_id)?.cancel_requested_at).toBeNull();
  } finally {
    await client?.close();
    srv.stop(true);
  }
});

test("chain.cancel on an unknown handoff returns the 404 envelope", async () => {
  const services = tempServices();
  const srv = startDaemon(services);
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    const daemon = new DaemonClient({
      baseUrl: `http://localhost:${String(srv.port)}`,
      token: "t",
    });
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: "chain_cancel",
      arguments: { handoff_id: "h-missing" },
    });
    const parsed = firstJson(out);

    expect(parsed).toEqual({
      error: { code: "not_found", message: "handoff h-missing not found" },
    });
  } finally {
    await client?.close();
    srv.stop(true);
  }
});

test("chain_send_message forwards content to the daemon", async () => {
  const daemon = fakeDaemon({
    sendChainMessage: (body: { handoff_id: string; content: string }) => {
      expect(body).toEqual({ handoff_id: "h-123", content: "answer the question" });
      return Promise.resolve({ ok: true as const });
    },
  });
  let client: Awaited<ReturnType<typeof connectInMemory>> | undefined;
  try {
    client = await connectInMemory(daemon);
    const out = await client.callTool({
      name: "chain_send_message",
      arguments: { handoff_id: "h-123", content: "answer the question" },
    });
    expect(firstText(out)).toContain('"ok": true');
  } finally {
    await client?.close();
  }
});
