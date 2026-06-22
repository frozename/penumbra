import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonFetchHandler } from "../../src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

interface VerifyBody {
  memory_id: string;
  last_verified_reason: string | null;
  last_verified_session_id: string | null;
}

function startTestDaemon(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "memory-verify-backdoor-"));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-12T12:00:00.000Z"),
  });

  const token = "tok";
  const handler = createDaemonFetchHandler({ services, token });

  return {
    fetch: (path: string, init?: RequestInit): Promise<Response> =>
      handler(new Request(`http://x${path}`, init)),
    services,
    token,
    stop: (): void => {
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
    },
  };
}

function insertT2(db: Database, memoryId: string, createdAt: string): void {
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at,
      last_verified_at, last_verified_by, last_verified_reason, last_verified_session_id,
      obs_type, concepts, severity, file_paths
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryId,
      null,
      "u1",
      "fact",
      "[]",
      createdAt,
      createdAt,
      memoryId,
      `body for ${memoryId}`,
      "{}",
      null,
      createdAt,
      createdAt,
      null,
      null,
      null,
      null,
      "feature",
      "[]",
      null,
      "[]",
    ],
  );
}

function readLastVerifiedAt(db: Database, memoryId: string): string | null {
  const row = db
    .query<
      { last_verified_at: string | null },
      [string]
    >(`SELECT last_verified_at FROM t2_memories WHERE memory_id = ?`)
    .get(memoryId);
  return row?.last_verified_at ?? null;
}

test("POST /memory/verify requires validated basis and leaves target unchanged on 4xx", async () => {
  const daemon = startTestDaemon();
  try {
    const createdAt = new Date("2026-05-12T11:00:00.000Z").toISOString();
    insertT2(daemon.services.db, "memory-backdoor-1", createdAt);

    const before = readLastVerifiedAt(daemon.services.db, "memory-backdoor-1");
    expect(before).toBeNull();

    const missingBasis = await daemon.fetch("/memory/verify", {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({
        memory_id: "memory-backdoor-1",
        claimed_by: "agent-name@worktree",
      }),
    });
    expect(missingBasis.status).toBe(400);

    const invalidBasis = await daemon.fetch("/memory/verify", {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({
        memory_id: "memory-backdoor-1",
        claimed_by: "agent-name@worktree",
        basis: { kind: "manual_override", reason: "", authorized_by: "lead" },
      }),
    });
    expect(invalidBasis.status).toBe(400);

    const after = readLastVerifiedAt(daemon.services.db, "memory-backdoor-1");
    expect(after).toBeNull();
  } finally {
    daemon.stop();
  }
});

test("POST /memory/verify accepts valid basis and stamps verification", async () => {
  const daemon = startTestDaemon();
  try {
    const createdAt = new Date("2026-05-12T11:00:00.000Z").toISOString();
    insertT2(daemon.services.db, "memory-backdoor-2", createdAt);

    const res = await daemon.fetch("/memory/verify", {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({
        memory_id: "memory-backdoor-2",
        claimed_by: "agent-name@worktree",
        reason: "manual spot check",
        session_id: "lane-xyz",
        basis: { kind: "manual_override", reason: "approved", authorized_by: "lead" },
      }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as VerifyBody;
    expect(body).toMatchObject({
      memory_id: "memory-backdoor-2",
      last_verified_reason: "manual spot check",
      last_verified_session_id: "lane-xyz",
    });

    const after = readLastVerifiedAt(daemon.services.db, "memory-backdoor-2");
    expect(after).not.toBeNull();
  } finally {
    daemon.stop();
  }
});
