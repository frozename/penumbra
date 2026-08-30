import type { AgentChatConfig } from "@src/config/types.js";
import type { DispatchOutput } from "@src/sdk/adapter.js";

import { buildServices, loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "@penumbra/daemon/test-utils";
import { registerAdapter } from "@src/adapters/registry.js";
import { runChatTurn } from "@src/cli/loop.js";
import { PenumbraClient } from "@src/penumbra-client.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

test("user → planner → @executor → approve → executor responds", async () => {
  // Spin up a tiny in-memory penumbra-shaped service
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: mkdtempSync(join(tmpdir(), "ac-e2e-services-")),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });

  const token = "test-token";
  const handler = createDaemonFetchHandler({ services, token });
  const fetchImpl: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      return handler(req);
    },
    { preconnect: fetch.preconnect.bind(fetch) },
  );

  const root = mkdtempSync(join(tmpdir(), "ac-e2e-"));
  writeFileSync(join(root, "port"), `1\n`);
  writeFileSync(join(root, "token"), `${token}\n`);

  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });

  // Register two fake adapters
  registerAdapter("plan-bot", () => ({
    kind: "plan-bot",
    dispatch: (): Promise<DispatchOutput> =>
      Promise.resolve({ text: "Plan: 1) do X. @executor please run." }),
  }));
  registerAdapter("exec-bot", () => ({
    kind: "exec-bot",
    dispatch: ({ prompt }): Promise<DispatchOutput> => Promise.resolve({ text: `done: ${prompt}` }),
  }));

  const config: AgentChatConfig = {
    agents: [
      { name: "planner", adapter: "plan-bot", options: {}, roles: ["planner"] },
      { name: "gemini", adapter: "exec-bot", options: {}, roles: ["executor"] },
    ],
    default_roles: { planner: "planner", executor: "gemini" },
  };

  const observe = (event: Record<string, unknown>): Promise<{ event_id: string }> =>
    client.observe(event);

  // 1) Planner runs
  const planTurn = await runChatTurn({
    config,
    initialAgent: "planner",
    userMessage: "add rate limiting",
    conversation: { id: "c-e2e", project_id: "auth" },
    observe,
  });
  expect(planTurn.next_mention?.target).toBe("executor");
  expect(planTurn.next_mention?.resolution.kind).toBe("role");

  // 2) Create the handoff via the route
  const created = await client.createHandoff({
    from: "planner",
    to: "gemini",
    to_role: "executor",
    message: planTurn.text,
    conversation_id: "c-e2e",
    project_id: "auth",
    triggered_by_event_id: planTurn.response_event_id,
  });
  expect(created.status).toBe("pending");

  // 3) Approve it
  const approved = await client.approve(created.handoff_id);
  expect(approved.status).toBe("approved");

  // 4) Verify pending list is empty
  const list = await client.listPending();
  expect(list.handoffs.length).toBe(0);

  // 5) Executor runs against the planner's message
  const execTurn = await runChatTurn({
    config,
    initialAgent: "gemini",
    userMessage: planTurn.text,
    conversation: { id: "c-e2e", project_id: "auth" },
    observe,
  });
  expect(execTurn.text).toContain("done:");

  // 6) Verify T0 event was written via transaction
  const count = db
    .query<
      { count: number },
      []
    >("SELECT COUNT(*) as count FROM t0_events WHERE event_type='agent-handoff'")
    .get()?.count;
  expect(count).toBe(1);

  // Verify observations were written
  const obsCount = db
    .query<
      { count: number },
      []
    >("SELECT COUNT(*) as count FROM t0_events WHERE event_type IN ('agent-prompt', 'agent-response')")
    .get()?.count;
  expect(obsCount).toBe(4);

  // No live daemon to stop (in-process handler).
});
