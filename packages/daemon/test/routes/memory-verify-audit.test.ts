import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { memoryVerifyRoute, memoryVerificationEventsRoute } from "../../src/routes/memory.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

function startTestDaemon(): {
  services: Services;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "memory-verify-audit-"));
  const baseMs = new Date("2026-05-12T12:00:00.000Z").getTime();
  let clockCounter = 0;
  const OriginalDate = Date;
  class AdvancingDate extends OriginalDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) {
        super(baseMs + clockCounter++);
        return;
      }
      super(...args);
    }

    static override now(): number {
      return baseMs + clockCounter++;
    }
  }
  globalThis.Date = AdvancingDate as unknown as DateConstructor;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(baseMs + clockCounter++),
  });

  return {
    services,
    stop: () => {
      try {
        services.supervisor.stopAll();
      } catch {}
      try {
        db.close();
      } catch {}
      globalThis.Date = OriginalDate;
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

test("POST /memory/verify appends audit events and server-derives verifier_actor", async () => {
  const daemon = startTestDaemon();
  try {
    const createdAt = new Date("2026-05-12T11:00:00.000Z").toISOString();
    insertT2(daemon.services.db, "memory-audit-1", createdAt);

    const first = await memoryVerifyRoute(
      new Request("http://x/memory/verify", {
        method: "POST",
        body: JSON.stringify({
          memory_id: "memory-audit-1",
          by: "attacker",
          reason: "manual spot check",
          session_id: "lane-xyz",
        }),
      }),
      daemon.services,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      memory_id: string;
      last_verified_by: string | null;
      last_verified_actor?: string | null;
      verifier_actor?: string;
      claimed_by?: string | null;
      event_id?: string;
    };
    expect(firstBody).toMatchObject({
      memory_id: "memory-audit-1",
      verifier_actor: daemon.services.machineId.get(),
      claimed_by: "attacker",
      last_verified_by: "attacker",
      last_verified_actor: daemon.services.machineId.get(),
    });
    expect(firstBody.event_id).toBeTruthy();

    const second = await memoryVerifyRoute(
      new Request("http://x/memory/verify", {
        method: "POST",
        body: JSON.stringify({
          memory_id: "memory-audit-1",
          claimed_by: "attacker-2",
          reason: "follow-up",
          session_id: "lane-abc",
        }),
      }),
      daemon.services,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      verifier_actor?: string;
      claimed_by?: string | null;
      event_id?: string;
    };
    expect(secondBody.verifier_actor).toBe(daemon.services.machineId.get());
    expect(secondBody.claimed_by).toBe("attacker-2");
    expect(secondBody.event_id).toBeTruthy();
    expect(secondBody.event_id).not.toBe(firstBody.event_id);

    const memoryRow = daemon.services.db
      .query<
        {
          last_verified_by: string | null;
          last_verified_actor: string | null;
          last_verified_reason: string | null;
          last_verified_session_id: string | null;
        },
        [string]
      >(
        `SELECT last_verified_by, last_verified_actor, last_verified_reason, last_verified_session_id
         FROM t2_memories
        WHERE memory_id = ?`,
      )
      .get("memory-audit-1")!;
    expect(memoryRow).toMatchObject({
      last_verified_by: "attacker-2",
      last_verified_actor: daemon.services.machineId.get(),
      last_verified_reason: "follow-up",
      last_verified_session_id: "lane-abc",
    });

    const auditRows = daemon.services.db
      .query<
        {
          event_id: string;
          verifier_actor: string;
          claimed_by: string | null;
          reason: string | null;
          session_id: string | null;
          verified_at: string;
        },
        [string]
      >(
        `SELECT event_id, verifier_actor, claimed_by, reason, session_id, verified_at
         FROM t2_memory_verification_events
        WHERE memory_id = ?
        ORDER BY verified_at ASC, rowid ASC`,
      )
      .all("memory-audit-1");
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]).toMatchObject({
      verifier_actor: daemon.services.machineId.get(),
      claimed_by: "attacker",
      reason: "manual spot check",
      session_id: "lane-xyz",
    });
    expect(auditRows[1]).toMatchObject({
      verifier_actor: daemon.services.machineId.get(),
      claimed_by: "attacker-2",
      reason: "follow-up",
      session_id: "lane-abc",
    });
  } finally {
    daemon.stop();
  }
});

test("GET /memory/:memory_id/verification_events returns the verification audit trail", async () => {
  const daemon = startTestDaemon();
  try {
    const createdAt = new Date("2026-05-12T11:00:00.000Z").toISOString();
    insertT2(daemon.services.db, "memory-audit-events", createdAt);

    await memoryVerifyRoute(
      new Request("http://x/memory/verify", {
        method: "POST",
        body: JSON.stringify({
          memory_id: "memory-audit-events",
          claimed_by: "attacker",
          reason: "manual spot check",
          session_id: "lane-xyz",
        }),
      }),
      daemon.services,
    );
    await memoryVerifyRoute(
      new Request("http://x/memory/verify", {
        method: "POST",
        body: JSON.stringify({
          memory_id: "memory-audit-events",
          claimed_by: "attacker-2",
          reason: "follow-up",
          session_id: "lane-abc",
        }),
      }),
      daemon.services,
    );

    const routeRes = await memoryVerificationEventsRoute(
      new Request("http://x/memory/memory-audit-events/verification_events?limit=2", {
        method: "GET",
      }),
      daemon.services,
    );
    expect(routeRes.status).toBe(200);
    const body = (await routeRes.json()) as {
      events: Array<{
        verifier_actor: string;
        claimed_by: string | null;
        reason: string | null;
        session_id: string | null;
      }>;
    };
    expect(body.events).toHaveLength(2);
    expect(body.events.map((event) => event.claimed_by).sort()).toEqual(["attacker", "attacker-2"]);
  } finally {
    daemon.stop();
  }
});
