import {
  buildServices,
  DispatchEventLog,
  HandoffReader,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { handoffsListPendingRoute } from "../../src/routes/handoffs.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function makeServices(db: Database): Services {
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/handoffs-use-worktree-contract-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    uuid: (() => {
      let n = 0;
      return (): string => {
        n += 1;
        return `evt-${String(n)}`;
      };
    })(),
    clock: () => new Date("2026-05-20T00:00:00.000Z"),
  });
  services.handoffWriter = new HandoffWriter({ db });
  services.handoffReader = new HandoffReader({ db });
  services.dispatchEventLog = new DispatchEventLog(db);
  return services;
}

test("GET /handoffs returns use_worktree as boolean|null, never integer", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  // Insert three rows directly via raw SQL with integer values (0, 1, NULL)
  // as bun:sqlite stores them — bypassing any zod preprocessing.
  db.prepare(
    `
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, use_worktree)
    VALUES (?, '2026-05-20T00:00:00Z', 'conv-contract', 'maestro', 'codex', 'task', 'pending', ?)
  `,
  ).run("h-worktree-false", 0);

  db.prepare(
    `
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, use_worktree)
    VALUES (?, '2026-05-20T00:00:01Z', 'conv-contract', 'maestro', 'gemini', 'task', 'pending', ?)
  `,
  ).run("h-worktree-true", 1);

  db.prepare(
    `
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, use_worktree)
    VALUES (?, '2026-05-20T00:00:02Z', 'conv-contract', 'maestro', 'claude', 'task', 'pending', ?)
  `,
  ).run("h-worktree-null", null);

  const res = await handoffsListPendingRoute(
    new Request("http://x/handoffs?status=pending"),
    services,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    handoffs: { handoff_id: string; use_worktree: unknown }[];
  };

  const byId = Object.fromEntries(body.handoffs.map((h) => [h.handoff_id, h.use_worktree]));

  // Each value must be boolean or null — never the integer 0 or 1.
  for (const [id, val] of Object.entries(byId)) {
    expect(
      typeof val === "boolean" || val === null,
      `handoff ${id}: use_worktree must be boolean|null, got ${JSON.stringify(val)} (${typeof val})`,
    ).toBe(true);
  }

  expect(byId["h-worktree-false"]).toBe(false);
  expect(byId["h-worktree-true"]).toBe(true);
  expect(byId["h-worktree-null"]).toBe(null);
});

test("GET /handoffs?status=pending coerces use_worktree via listByStatus path", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  db.prepare(
    `
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, use_worktree)
    VALUES ('h-lbs-0', '2026-05-20T00:00:00Z', 'conv-lbs', 'a', 'b', 't', 'pending', 0)
  `,
  ).run();
  db.prepare(
    `
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, use_worktree)
    VALUES ('h-lbs-1', '2026-05-20T00:00:01Z', 'conv-lbs', 'a', 'c', 't', 'pending', 1)
  `,
  ).run();

  // Hit with explicit status= param (routes through listByStatus, not listPending)
  const res = await handoffsListPendingRoute(
    new Request("http://x/handoffs?status=pending"),
    services,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    handoffs: { handoff_id: string; use_worktree: unknown }[];
  };

  const lbs = body.handoffs.filter((h) => h.handoff_id.startsWith("h-lbs-"));
  expect(lbs.length).toBe(2);
  for (const h of lbs) {
    expect(typeof h.use_worktree === "boolean" || h.use_worktree === null).toBe(true);
  }
  const byId = Object.fromEntries(lbs.map((h) => [h.handoff_id, h.use_worktree]));
  expect(byId["h-lbs-0"]).toBe(false);
  expect(byId["h-lbs-1"]).toBe(true);
});
