import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { reconcilerVerdictsRoute } from "../../src/routes/reconciler.js";
import { createDaemonFetchHandler } from "../../src/serve.js";

interface VerdictRow {
  event_id: string;
  handoff_id: string;
  conversation_id: string;
  to_agent: string;
  chain_task_type: string;
  verdict: {
    branch: string;
    typecheck: string;
    tests: string;
    pr_url: string | null;
    summary: string;
  };
}
interface VerdictsBody {
  verdicts: VerdictRow[];
}

function services(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/reconciler-verdicts-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-08T00:00:00.000Z"),
    uuid: () => `id-${String(++n)}`,
  });
}

function seedHandoff(
  svc: Services,
  handoffId: string,
  conversationId: string,
  agent = "codex-mini",
): void {
  svc.handoffWriter.createApproved({
    handoff_id: handoffId,
    ts: "2026-05-08T00:00:00.000Z",
    project_id: null,
    conversation_id: conversationId,
    from: "user",
    to: agent,
    to_role: null,
    message: `dispatch ${handoffId}`,
    triggered_by_event_id: `evt-${handoffId}`,
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: "implement_small",
    use_worktree: true,
    parent_handoff_id: null,
    branch_base: null,
    open_pr_on_review: false,
  });
}

function writeVerdictEvent(
  svc: Services,
  input: {
    event_id: string;
    ts: string;
    handoff_id: string;
    conversation_id: string;
    pr_url: string | null;
  },
): void {
  svc.t0Writer.write({
    event_id: input.event_id,
    ts: input.ts,
    ingest_ts: input.ts,
    source: "agentchat",
    source_detail: "merge-reconciler",
    project_id: null,
    user_id: "local-user",
    machine_id: "machine-1",
    session_id: input.conversation_id,
    event_type: "reconciler.verdict",
    lane: "local",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {
      handoff_id: input.handoff_id,
      conversation_id: input.conversation_id,
      branch: `agent/${input.handoff_id}`,
      head_sha: `head-${input.handoff_id}`,
      base_sha: "base-main",
      typecheck: "pass",
      tests: "pass",
      files_changed: 1,
      lines_added: 2,
      lines_deleted: 1,
      ff_mergeable: true,
      rebase_required: false,
      pr_url: input.pr_url,
      verified_at: input.ts,
      duration_ms: 1234,
      summary: "ready to land",
    },
    payload_summary: "ready to land",
  });
}

describe("reconcilerVerdictsRoute", () => {
  test("returns reconciler verdict events joined with handoff metadata", async () => {
    const svc = services();
    seedHandoff(svc, "h-1", "c-1");
    writeVerdictEvent(svc, {
      event_id: "v-1",
      ts: "2026-05-08T00:01:00.000Z",
      handoff_id: "h-1",
      conversation_id: "c-1",
      pr_url: null,
    });

    const res = await reconcilerVerdictsRoute(
      new Request("http://x/reconciler/verdicts?limit=10"),
      svc,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as VerdictsBody;
    expect(body.verdicts).toHaveLength(1);
    expect(body.verdicts[0]).toMatchObject({
      event_id: "v-1",
      handoff_id: "h-1",
      conversation_id: "c-1",
      to_agent: "codex-mini",
      chain_task_type: "implement_small",
      verdict: {
        branch: "agent/h-1",
        typecheck: "pass",
        tests: "pass",
        pr_url: null,
        summary: "ready to land",
      },
    });
  });

  test("filters to only_unverified verdicts when requested", async () => {
    const svc = services();
    seedHandoff(svc, "h-1", "c-1");
    seedHandoff(svc, "h-2", "c-2");
    writeVerdictEvent(svc, {
      event_id: "v-1",
      ts: "2026-05-08T00:01:00.000Z",
      handoff_id: "h-1",
      conversation_id: "c-1",
      pr_url: null,
    });
    writeVerdictEvent(svc, {
      event_id: "v-2",
      ts: "2026-05-08T00:02:00.000Z",
      handoff_id: "h-2",
      conversation_id: "c-2",
      pr_url: "https://github.com/example/repo/pull/2",
    });

    const res = await reconcilerVerdictsRoute(
      new Request("http://x/reconciler/verdicts?limit=10&only_unverified=true"),
      svc,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as VerdictsBody;
    expect(body.verdicts.map((v) => v.handoff_id)).toEqual(["h-1"]);
  });

  test("serve.ts wires authenticated GET /reconciler/verdicts", async () => {
    const svc = services();
    seedHandoff(svc, "h-serve", "c-serve");
    writeVerdictEvent(svc, {
      event_id: "v-serve",
      ts: "2026-05-08T00:01:00.000Z",
      handoff_id: "h-serve",
      conversation_id: "c-serve",
      pr_url: null,
    });

    const handler = createDaemonFetchHandler({ services: svc, token: "tok" });
    const res = await handler(
      new Request("http://x/reconciler/verdicts?limit=10", {
        headers: { authorization: "Bearer tok" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as VerdictsBody;
    expect(body.verdicts[0]?.handoff_id).toBe("h-serve");
  });

  test("normalizes since with timezone offset before ts comparison", async () => {
    const svc = services();
    seedHandoff(svc, "h-tz-1", "c-tz-1");
    seedHandoff(svc, "h-tz-2", "c-tz-2");
    writeVerdictEvent(svc, {
      event_id: "v-tz-1",
      ts: "2026-05-08T02:30:00.000Z",
      handoff_id: "h-tz-1",
      conversation_id: "c-tz-1",
      pr_url: null,
    });
    writeVerdictEvent(svc, {
      event_id: "v-tz-2",
      ts: "2026-05-08T03:30:00.000Z",
      handoff_id: "h-tz-2",
      conversation_id: "c-tz-2",
      pr_url: null,
    });

    const res = await reconcilerVerdictsRoute(
      new Request("http://x/reconciler/verdicts?limit=10&since=2026-05-08T00%3A00%3A00-03%3A00"),
      svc,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as VerdictsBody;
    expect(body.verdicts.map((v) => v.handoff_id)).toEqual(["h-tz-2"]);
  });
});
