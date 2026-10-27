import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { usageProviderQuotasRoute } from "@src/routes/usage.js";
import { createDaemonFetchHandler } from "@src/serve.js";
import { listProviderQuotaStatus } from "@src/services/provider-concurrency.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const ANTHROPIC_QUOTA = { provider: "anthropic", max_in_flight: 2, in_flight: 1 };
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// One provider-wide cap (anthropic, 2), one uncapped provider (openai), and one
// dispatched handoff on an anthropic seat, so the expected in_flight is 1.
function servicesWithOneDispatched(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "usage-provider-quotas-"));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-21T10:00:00.000Z"),
  });
  cleanups.push(() => {
    try {
      services.supervisor.stopAll();
    } catch {
      /* already stopped */
    }
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(root, { recursive: true, force: true });
  });
  services.agentchatConfig = {
    agents: [
      {
        name: "claude-a",
        roles: [],
        adapter: "stdio-acp",
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
      {
        name: "claude-b",
        roles: [],
        adapter: "stdio-acp",
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
    ],
  };
  services.providerQuotas = [{ provider: "anthropic", max_in_flight: 2 }, { provider: "openai" }];
  services.handoffWriter.createApproved({
    handoff_id: "h-quota-1",
    ts: "2026-05-21T10:00:00.000Z",
    project_id: null,
    conversation_id: "conv-h-quota-1",
    from: "planner",
    to: "claude-a",
    to_role: null,
    message: "go",
    triggered_by_event_id: null,
    resolved_by: "machine-test",
    resolved_at: "2026-05-21T10:00:00.000Z",
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    dispatch_kind: null,
    workflow_run_id: null,
  });
  expect(services.handoffWriter.claimDispatch("h-quota-1", "W-A")).toBe(true);
  return services;
}

test("usageProviderQuotasRoute returns the provider-wide caps with live in-flight counts", async () => {
  const services = servicesWithOneDispatched();
  const res = usageProviderQuotasRoute(services);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  expect(body).toEqual({ provider_quotas: [ANTHROPIC_QUOTA] });
  expect(body).toEqual({ provider_quotas: listProviderQuotaStatus(services) });
});

test("GET /usage/provider_quotas is served behind the bearer token and only for GET", async () => {
  const services = servicesWithOneDispatched();
  const handler = createDaemonFetchHandler({ services, token: "tok" });

  const ok = await handler(
    new Request("http://x/usage/provider_quotas", { headers: { authorization: "Bearer tok" } }),
  );
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ provider_quotas: [ANTHROPIC_QUOTA] });

  const unauthenticated = await handler(new Request("http://x/usage/provider_quotas"));
  expect(unauthenticated.status).toBe(401);

  const post = await handler(
    new Request("http://x/usage/provider_quotas", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
    }),
  );
  expect(post.status).toBe(404);
});

test("reading provider quotas leaves the quota config and the in-flight count unchanged", () => {
  const services = servicesWithOneDispatched();
  const before = services.providerQuotas;
  usageProviderQuotasRoute(services);
  usageProviderQuotasRoute(services);
  expect(services.providerQuotas).toBe(before);
  expect(listProviderQuotaStatus(services)).toEqual([ANTHROPIC_QUOTA]);
});
