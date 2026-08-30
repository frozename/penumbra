import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry, composeRecall, executeWorkflow } from "@src/index.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function insertEvent(db: Database, id: string, sessionId: string, summary: string): void {
  db.prepare(
    `INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
      event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
      request_id, payload_json, payload_summary, origin
    ) VALUES (?, ?, ?, 'test', NULL, 'penumbra', 'u', 'm', ?, ?, 'unknown', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, '{}', ?, 'unknown')`,
  ).run(
    id,
    `2026-06-11T12:00:0${id.slice(-1)}Z`,
    `2026-06-11T12:00:0${id.slice(-1)}Z`,
    sessionId,
    id === "e1" ? "agent-prompt" : "agent-response",
    summary,
  );
}

test("session-memory-sweep writes next-session-prompt output", async () => {
  const root = join(tmpdir(), `session-memory-sweep-${crypto.randomUUID()}`);
  const workflowsDir = join(root, "workflows");
  const sessionId = "session-1";
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    mkdirSync(join(workflowsDir, "session-memory-sweep"), { recursive: true });
    writeFileSync(
      join(workflowsDir, "session-memory-sweep", "workflow.ts"),
      readFileSync(
        join(import.meta.dir, "../../../../plugin/workflows/session-memory-sweep/workflow.ts"),
        "utf8",
      ),
    );

    const registry = await buildRegistry({ workflowsDir });
    expect(registry.errors).toEqual([]);
    const entry = registry.getEntry("session-memory-sweep");
    expect(entry).toBeTruthy();

    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    insertEvent(
      db,
      "e1",
      sessionId,
      "We need a close-time session memory sweep that extracts durable candidates but does not write them without approval. ".repeat(
        2,
      ),
    );
    insertEvent(
      db,
      "e2",
      sessionId,
      "The daemon route owns dedupe and returns create/update candidates for a markdown approval block.",
    );
    insertEvent(
      db,
      "e3",
      sessionId,
      "The next-session prompt should contain either candidate details or a no new candidates marker.",
    );

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/memory/session-extract")
          return new Response("not found", { status: 404 });
        const body = (await req.json()) as { session_id?: string };
        expect(body.session_id).toBe(sessionId);
        return Response.json({
          candidates: [
            {
              action: "create",
              slug: "approval-surface-required",
              title: "Approval surface required",
              body: "The sweep workflow renders candidate memory entries but leaves durable t2 writes to explicit approval mode.",
              hook: "When session-memory-sweep runs at close time",
              why: "This preserves human approval for durable cross-session memory.",
              backlinks: [],
            },
          ],
        });
      },
    });
    writeFileSync(join(root, "port"), String(server.port));
    writeFileSync(join(root, "token"), "test-token");

    const spec = {
      ...entry!.spec,
      output: [{ kind: "next-session-prompt" as const }],
    };
    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: root,
      project: "penumbra",
      sources: spec.recall,
      budgetTokens: spec.recall_budget_tokens,
    });

    const previousMinEvents = process.env.PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS;
    process.env.PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS = "3";
    try {
      const result = await executeWorkflow({
        spec,
        bundle,
        fn: entry!.fn,
        storageRoot: root,
        ctx: {
          config: {},
          cwd: root,
          storageRoot: root,
          project: "penumbra",
          args: { session_id: sessionId, project_id: "penumbra" },
          db: (): Database => db,
          dispatch: () =>
            Promise.resolve({ conversation_id: "conversation", handoff_id: "handoff" }),
          awaitChain: () =>
            Promise.resolve({
              status: "timeout" as const,
              final_agent: null,
              response_text: null,
            }),
          fileWrite: () => Promise.resolve("/tmp/out"),
        },
        captureCtx: { db, project: "penumbra", sessionId, userId: "u", machineId: "m" },
      });

      expect(result.outcome).toBe("success");
      const promptPath = join(root, "pending-handoff.md");
      expect(existsSync(promptPath)).toBe(true);
      const body = readFileSync(promptPath, "utf8");
      expect(
        body.includes("## Session memory candidates") || body.includes("no new candidates"),
      ).toBe(true);
    } finally {
      if (previousMinEvents === undefined)
        delete process.env.PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS;
      else process.env.PENUMBRA_DREAMING_T2_PROMOTION_MIN_EVENTS = previousMinEvents;
    }
  } finally {
    await server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
