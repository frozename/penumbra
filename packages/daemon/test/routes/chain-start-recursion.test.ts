import { beforeAll, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { chainsStartRoute } from "../../src/routes/chains.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {}

// strict-mode env can leak from a live maestro shell; clear it here so test fixtures stay deterministic
beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/recursion-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-27T00:00:00Z"),
    uuid: () => `id-${++n}`,
    agentRegistry: ["planner", "executor"],
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };
  return services;
}

function seedChain(services: Services, depth: number): string {
  // Insert a chain of 'depth' handoffs. Returns the leaf handoff_id.
  // Inserts directly; no ts collisions matter for the depth walk.
  let prev: string | null = null;
  let last = "";
  for (let i = 0; i < depth; i++) {
    const id = `seed-h-${i}`;
    services.db
      .prepare(
        `
      INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, parent_handoff_id)
      VALUES (?, datetime('now'), 'seed-c', 'a', 'b', 'm', 'completed', ?)
    `,
      )
      .run(id, prev);
    prev = id;
    last = id;
  }
  return last;
}

afterEach(() => {
  delete process.env.PENUMBRA_RECURSION_DEPTH_CAP;
});

test("chain.start without parent_handoff_id passes recursion guard", async () => {
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({ initial_agent: "planner", message: "hi" }),
    }),
    services,
  );
  expect(res.status).toBe(200);
});

test("chain.start with parent at depth 6 (newDepth=7) passes one below cap=8", async () => {
  const services = tempServices();
  const parentLeaf = seedChain(services, 7); // 7 rows: depths 0..6, parentLeaf at depth 6
  // New dispatch with parent=parentLeaf would land at depth 7 → under cap of 8.
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        parent_handoff_id: parentLeaf,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
});

test("chain.start with parent at depth 7 (newDepth=8) rejects at cap=8", async () => {
  const services = tempServices();
  const parentLeaf = seedChain(services, 8); // 8 rows: depths 0..7, parentLeaf at depth 7
  // New dispatch would be depth 8 → meets cap → reject.
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        parent_handoff_id: parentLeaf,
      }),
    }),
    services,
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error.code).toBe("recursion_depth_exceeded");
  expect(body.error.depth).toBe(8);
  expect(body.error.cap).toBe(8);
});

test("PENUMBRA_RECURSION_DEPTH_CAP env var raises the cap", async () => {
  process.env.PENUMBRA_RECURSION_DEPTH_CAP = "16";
  const services = tempServices();
  const parentLeaf = seedChain(services, 9); // would reject under default cap
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        parent_handoff_id: parentLeaf,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
});

test("chain.start with unknown parent_handoff_id treats depth as 0 and passes", async () => {
  // If parent doesn't exist, getSpawnDepth returns 0; new dispatch is depth 1.
  // This is permissive by design — better to allow than to fail closed on stale ids.
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        parent_handoff_id: "nonexistent-id",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
});

test("chain.start persists parent_handoff_id when provided", async () => {
  const services = tempServices();
  const parentLeaf = seedChain(services, 1);
  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "hi",
        parent_handoff_id: parentLeaf,
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db
    .query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
    .get(body.handoff_id);
  expect(handoff.parent_handoff_id).toBe(parentLeaf);
});

test("chain.start inherits isolated_install from an isolated parent when child omits it", async () => {
  const services = tempServices();
  services.handoffWriter.createApproved({
    handoff_id: "h-parent-isolated",
    ts: "2026-04-27T00:00:00Z",
    project_id: null,
    conversation_id: "conv-parent-isolated",
    from: "user",
    to: "planner",
    to_role: null,
    message: "parent",
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: true,
    isolated_install: true,
    parent_handoff_id: null,
  });

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: "child",
        parent_handoff_id: "h-parent-isolated",
      }),
    }),
    services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db
    .query<
      { isolated_install: number | null },
      [string]
    >(`SELECT isolated_install FROM handoffs WHERE handoff_id=?`)
    .get(body.handoff_id);
  expect(handoff?.isolated_install).toBe(1);
});
