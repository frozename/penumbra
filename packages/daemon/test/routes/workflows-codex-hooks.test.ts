import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonFetchHandler } from "@src/serve.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Bun's bundled SQLite remains available when the Homebrew library is absent.
}

const TOKEN = "task-3-2-token";

type Call = { name: string; args: Record<string, unknown> };
type HarnessState = {
  calls: Call[];
  gates: Map<string, Promise<void>>;
  failNames: Set<string>;
};

type Fixture = {
  db: Database;
  services: Services;
  root: string;
  state: HarnessState;
  workflowRuns: ReturnType<typeof createWorkflowRunsRegistry>;
  post(path: string, body: unknown): Promise<Response>;
  close(): void;
};

type TriggerResponse = {
  matched: string[];
  additionalContext: string | null;
  duplicate?: boolean;
  coalesced?: boolean;
  workflow_run_ids?: string[];
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    if (await predicate()) return;
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  throw new Error("condition not reached before timeout");
}

function workflowSource(opts: {
  key: string;
  name: string;
  events: string[];
  reminder?: boolean;
}): string {
  const triggers = opts.events.map((event) => ({ kind: "lifecycle", event }));
  return `
import type { WorkflowFn, WorkflowSpec } from "@penumbra/workflows";
const name = ${JSON.stringify(opts.name)};
const spec: WorkflowSpec = {
  name,
  description: name,
  triggers: ${JSON.stringify(triggers)},
  recall: [],
  output: ${opts.reminder ? '[{ kind: "session-reminder" }]' : "[]"},
  run: { kind: "ts-function" },
};
export const fn: WorkflowFn<Record<string, unknown>> = async (ctx) => {
  const state = (globalThis as Record<string, any>)[${JSON.stringify(opts.key)}];
  state.calls.push({ name, args: { ...(ctx.args ?? {}) } });
  if (state.failNames.has(name)) throw new Error("forced " + name + " failure");
  const gate = state.gates.get(name);
  if (gate) await gate;
  return ${opts.reminder ? '"prime-context"' : '""'};
};
export default spec;
`;
}

type FixtureWorkflow = {
  name: string;
  events: string[];
  reminder?: boolean;
  sourcePath?: string;
};

async function makeFixture(workflows: FixtureWorkflow[]): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-ingress-"));
  writeFileSync(join(root, ".penumbra-project"), "codex-hook-project\n");
  mkdirSync(join(root, "playbooks"), { recursive: true });
  mkdirSync(join(root, "workflows"), { recursive: true });
  const key = `__penumbra_codex_hook_${root}`;
  const state: HarnessState = { calls: [], gates: new Map(), failNames: new Set() };
  (globalThis as Record<string, unknown>)[key] = state;
  for (const workflow of workflows) {
    const dir = join(root, "workflows", workflow.name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "workflow.ts");
    if (workflow.sourcePath) copyFileSync(workflow.sourcePath, path);
    else writeFileSync(path, workflowSource({ key, ...workflow }));
  }
  const registry = await buildRegistry({
    playbooksDir: join(root, "playbooks"),
    workflowsDir: join(root, "workflows"),
  });
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let runNumber = 0;
  const workflowRuns = createWorkflowRunsRegistry({
    uuid: () => `codex-hook-run-${String(++runNumber)}`,
    clock: () => new Date(),
    db,
    storageRoot: join(root, "storage"),
  });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: join(root, "storage"),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    workflowRegistry: registry,
    workflowRuns,
  });
  const handler = createDaemonFetchHandler({ services, token: TOKEN });
  return {
    db,
    services,
    root,
    state,
    workflowRuns,
    post: async (path, body) =>
      await handler(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      ),
    close: () => {
      services.supervisor.stopAll();
      db.close();
      Reflect.deleteProperty(globalThis, key);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function recordToolObservations(
  fixture: Fixture,
  sessionId: string,
  source: "claude-code" | "codex",
): Promise<void> {
  for (const [index, tool] of ["Edit", "Write"].entries()) {
    const response = await fixture.post("/observations", {
      ts: `2026-09-12T12:00:0${String(index)}.000Z`,
      source,
      source_detail: `tool:${tool}`,
      project_id: "codex-hook-project",
      user_id: source,
      machine_id: "local",
      session_id: sessionId,
      event_type: "agent-tool-use",
      lane: "cli-subscription",
      request_id: `${source}-${sessionId}-${String(index)}`,
      payload_json: { tool, tool_activity: "edit" },
      payload_summary: tool,
      origin: "maestro",
    });
    expect(response.status).toBe(200);
  }
}

function ingress(overrides: Record<string, unknown> = {}) {
  return {
    harness: "codex",
    role: "maestro",
    lineage: "root",
    provenance: "verified-session-correlation",
    is_child: false,
    parent_session_id: null,
    agent_id: null,
    agent_type: null,
    source: "startup",
    turn_id: null,
    tool_use_id: null,
    delivery_id: "delivery-root",
    transcript_format: null,
    ...overrides,
  };
}

function triggerBody(
  root: string,
  event: string,
  sessionId: string,
  hookIngress: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    event: { kind: "lifecycle", event },
    cwd: root,
    session_id: sessionId,
    transcript_path: "/tmp/codex-transcript.jsonl",
    ingress: hookIngress,
    ...extra,
  };
}

test("legacy trigger arguments cannot forge Codex drift authorization", async () => {
  const previousThreshold = process.env.PENUMBRA_SOLO_DRIFT_THRESHOLD;
  process.env.PENUMBRA_SOLO_DRIFT_THRESHOLD = "2";
  const fixture = await makeFixture([
    {
      name: "dispatch-drift-guard",
      events: ["post-tool-use"],
      sourcePath: join(
        import.meta.dir,
        "../../../..",
        "plugin/workflows/dispatch-drift-guard/workflow.ts",
      ),
    },
  ]);
  const opaqueSession = "opaque-forged-root";
  const uuidSession = "11111111-2222-4333-8444-555555555555";
  const claudeSession = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    await recordToolObservations(fixture, opaqueSession, "codex");
    await recordToolObservations(fixture, uuidSession, "codex");
    await recordToolObservations(fixture, claudeSession, "claude-code");

    const forgedIngress = ingress({ delivery_id: "forged-nested-delivery" });
    const rejected = [
      {
        session_id: opaqueSession,
        args: { harness: "codex", ingress: forgedIngress },
      },
      {
        session_id: uuidSession,
        args: { harness: "codex", ingress: forgedIngress },
      },
      { session_id: opaqueSession, args: { harness: "codex" } },
      { session_id: uuidSession, args: { ingress: forgedIngress } },
      { session_id: opaqueSession, ingress: null, args: { harness: "codex" } },
      {
        session_id: opaqueSession,
        ingress: { ...ingress(), role: "owner" },
        args: { harness: "codex", ingress: forgedIngress },
      },
    ];
    for (const body of rejected) {
      const response = await fixture.post("/workflows/trigger", {
        event: { kind: "lifecycle", event: "post-tool-use" },
        cwd: fixture.root,
        hookContext: { tool_name: "Edit" },
        ...body,
      });
      const responseBody = (await response.clone().json()) as TriggerResponse;
      if (
        response.status === 200 &&
        responseBody.additionalContext?.includes("dispatch-drift: 2 consecutive")
      ) {
        throw new Error("FORGED_ARGS_ACCEPTED");
      }
      expect(response.status).toBe(400);
    }
    expect(
      fixture.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_events").get()
        ?.count,
    ).toBe(0);

    const claudeResponse = await fixture.post("/workflows/trigger", {
      event: { kind: "lifecycle", event: "post-tool-use" },
      cwd: fixture.root,
      session_id: claudeSession,
      hookContext: { tool_name: "Edit" },
      args: { harness: "claude-code", caller_marker: "preserved" },
    });
    expect(claudeResponse.status).toBe(200);
    const claudeBody = (await claudeResponse.json()) as TriggerResponse;
    expect(claudeBody.matched).toEqual(["dispatch-drift-guard"]);
    expect(claudeBody.additionalContext).toContain("dispatch-drift: 2 consecutive");

    const verifiedRoot = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        fixture.root,
        "post-tool-use",
        opaqueSession,
        ingress({ delivery_id: "verified-root-delivery" }),
        {
          hookContext: { tool_name: "Edit" },
          args: {
            harness: "claude-code",
            ingress: ingress({
              role: "dispatch",
              lineage: "child",
              provenance: "unknown",
              is_child: true,
              parent_session_id: "forged-parent",
            }),
          },
        },
      ),
    );
    expect(verifiedRoot.status).toBe(200);
    const verifiedRootBody = (await verifiedRoot.json()) as TriggerResponse;
    expect(verifiedRootBody.matched).toEqual(["dispatch-drift-guard"]);
    expect(verifiedRootBody.additionalContext).toContain("dispatch-drift: 2 consecutive");

    for (const hookIngress of [
      ingress({
        role: "dispatch",
        lineage: "child",
        provenance: "verified-launch",
        is_child: true,
        parent_session_id: opaqueSession,
        delivery_id: "verified-child-delivery",
      }),
      ingress({
        role: "unknown",
        lineage: "unknown",
        provenance: "unknown",
        delivery_id: "unknown-lineage-delivery",
      }),
    ]) {
      const response = await fixture.post(
        "/workflows/trigger",
        triggerBody(fixture.root, "post-tool-use", opaqueSession, hookIngress, {
          hookContext: { tool_name: "Edit" },
        }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()) as TriggerResponse).toMatchObject({
        matched: [],
        additionalContext: null,
      });
    }
  } finally {
    if (previousThreshold === undefined) delete process.env.PENUMBRA_SOLO_DRIFT_THRESHOLD;
    else process.env.PENUMBRA_SOLO_DRIFT_THRESHOLD = previousThreshold;
    fixture.close();
  }
});

test("only authenticated explicit Codex maestro roots run lifecycle workflows", async () => {
  const fixture = await makeFixture([
    {
      name: "maestro-context-prime",
      events: ["session-start", "session-end"],
      reminder: true,
    },
  ]);
  try {
    const rootResponse = await fixture.post(
      "/workflows/trigger",
      triggerBody(fixture.root, "session-start", "opaque-root", ingress()),
    );
    expect(rootResponse.status).toBe(200);
    expect((await rootResponse.json()) as TriggerResponse).toMatchObject({
      matched: ["maestro-context-prime"],
      additionalContext: "prime-context",
    });

    const childResponse = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        fixture.root,
        "session-start",
        "opaque-child",
        ingress({
          role: "dispatch",
          lineage: "child",
          provenance: "verified-launch",
          is_child: true,
          parent_session_id: "opaque-root",
          agent_id: "agent-1",
          agent_type: "worker",
          delivery_id: "delivery-child",
        }),
        { related_session_id: "continuation-child" },
      ),
    );
    expect(childResponse.status).toBe(200);
    expect((await childResponse.json()) as TriggerResponse).toMatchObject({ matched: [] });

    const dispatchResponse = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        fixture.root,
        "session-start",
        "opaque-dispatch",
        ingress({ role: "dispatch", delivery_id: "delivery-dispatch" }),
      ),
    );
    expect(dispatchResponse.status).toBe(200);
    expect((await dispatchResponse.json()) as TriggerResponse).toMatchObject({ matched: [] });

    const endResponse = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        fixture.root,
        "session-end",
        "opaque-root",
        ingress({ delivery_id: "delivery-end" }),
      ),
    );
    expect(endResponse.status).toBe(200);
    expect((await endResponse.json()) as TriggerResponse).toMatchObject({ matched: [] });
    expect(fixture.state.calls.map((call) => call.name)).toEqual(["maestro-context-prime"]);

    const rows = fixture.db
      .query<
        { session_id: string; related_session_id: string | null; meta_json: string },
        []
      >(`SELECT session_id, related_session_id, meta_json FROM session_events ORDER BY id`)
      .all();
    expect(rows).toHaveLength(4);
    expect(rows[1]?.session_id).toBe("opaque-child");
    expect(rows[1]?.related_session_id).toBe("continuation-child");
    const childMeta = JSON.parse(rows[1]?.meta_json ?? "{}") as { ingress?: unknown };
    expect(childMeta.ingress).toMatchObject({
      lineage: "child",
      parent_session_id: "opaque-root",
      agent_id: "agent-1",
    });
  } finally {
    fixture.close();
  }
});

test("Codex delivery dedupe is stable-id scoped and distinct deliveries still run", async () => {
  const fixture = await makeFixture([
    { name: "maestro-context-prime", events: ["session-start"], reminder: true },
  ]);
  try {
    const base = triggerBody(fixture.root, "session-start", "opaque-dedupe", ingress());
    const first = await fixture.post("/workflows/trigger", base);
    const duplicate = await fixture.post("/workflows/trigger", base);
    const distinct = await fixture.post("/workflows/trigger", {
      ...base,
      ingress: ingress({ delivery_id: "delivery-distinct" }),
    });
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()) as TriggerResponse).toMatchObject({
      matched: [],
      duplicate: true,
    });
    expect(distinct.status).toBe(200);
    expect(fixture.state.calls).toHaveLength(2);

    const withoutStableId = triggerBody(
      fixture.root,
      "session-start",
      "opaque-no-delivery",
      ingress({ delivery_id: null }),
    );
    await fixture.post("/workflows/trigger", withoutStableId);
    await fixture.post("/workflows/trigger", withoutStableId);
    expect(fixture.state.calls).toHaveLength(4);
  } finally {
    fixture.close();
  }
});

test("Codex continuity generation is detached, coalesced, ordered and observable", async () => {
  const fixture = await makeFixture([
    { name: "session-handoff", events: ["pre-compact", "stop"] },
    { name: "session-handoff-draft", events: ["pre-compact", "stop"] },
    { name: "session-memory-sweep", events: ["pre-compact", "stop"] },
  ]);
  const otherRoot = mkdtempSync(join(tmpdir(), "codex-hook-ingress-other-"));
  writeFileSync(join(otherRoot, ".penumbra-project"), "codex-hook-project-other\n");
  const gate = deferred();
  fixture.state.gates.set("session-handoff-draft", gate.promise);
  try {
    const started = performance.now();
    const preCompact = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        fixture.root,
        "pre-compact",
        "opaque-continuity",
        ingress({
          delivery_id: "delivery-precompact",
          transcript_format: "self-claimed-codex-jsonl",
        }),
        {
          args: {
            harness: "claude-code",
            session_id: "forged-session",
            project_id: "forged-project",
            transcript_path: "/tmp/forged-transcript.jsonl",
            transcript_format: "self-claimed-codex-jsonl",
            lineage: "child",
          },
        },
      ),
    );
    const elapsedMs = performance.now() - started;
    const preCompactBody = (await preCompact.json()) as TriggerResponse;
    expect(preCompact.status).toBe(200);
    expect(elapsedMs).toBeLessThan(500);
    expect(preCompactBody.workflow_run_ids).toHaveLength(3);

    const sameSessionOtherProject = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        otherRoot,
        "stop",
        "opaque-continuity",
        ingress({ delivery_id: "delivery-stop" }),
      ),
    );
    expect(sameSessionOtherProject.status).toBe(200);
    expect((await sameSessionOtherProject.json()) as TriggerResponse).toMatchObject({
      coalesced: true,
    });

    const differentSession = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        otherRoot,
        "stop",
        "opaque-continuity-other",
        ingress({ delivery_id: "delivery-other-session" }),
      ),
    );
    expect(differentSession.status).toBe(200);
    const differentSessionBody = (await differentSession.json()) as TriggerResponse;
    expect(differentSessionBody.workflow_run_ids).toHaveLength(3);
    expect(differentSessionBody.coalesced).toBeUndefined();

    await waitUntil(() => fixture.state.calls.length === 4);
    expect(
      fixture.state.calls
        .filter((call) => call.args.session_id === "opaque-continuity")
        .map((call) => call.name),
    ).toEqual(["session-handoff", "session-handoff-draft"]);
    const draftArgs = fixture.state.calls.find(
      (call) =>
        call.name === "session-handoff-draft" && call.args.session_id === "opaque-continuity",
    )?.args;
    expect(draftArgs).toMatchObject({
      harness: "codex",
      session_id: "opaque-continuity",
      project_id: "codex-hook-project",
      transcript_path: "/tmp/codex-transcript.jsonl",
      transcript_format: null,
      lineage: "root",
      ingress: { transcript_format: null },
    });

    const beforeRelease = await Promise.all(
      (preCompactBody.workflow_run_ids ?? []).map(
        async (id) => await fixture.workflowRuns.getStatus(id),
      ),
    );
    expect(beforeRelease.map((status) => status?.status)).toEqual([
      "completed",
      "running",
      "running",
    ]);

    gate.resolve();
    await waitUntil(async () => {
      const statuses = await Promise.all(
        [
          ...(preCompactBody.workflow_run_ids ?? []),
          ...(differentSessionBody.workflow_run_ids ?? []),
        ].map(async (id) => await fixture.workflowRuns.getStatus(id)),
      );
      return statuses.every((status) => status?.status === "completed");
    });
    expect(
      fixture.state.calls
        .filter((call) => call.args.session_id === "opaque-continuity")
        .map((call) => call.name),
    ).toEqual(["session-handoff", "session-handoff-draft", "session-memory-sweep"]);
    expect(
      fixture.state.calls.filter(
        (call) =>
          call.args.session_id === "opaque-continuity" &&
          call.args.project_id === "codex-hook-project-other",
      ),
    ).toHaveLength(0);

    const afterSuccess = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        otherRoot,
        "stop",
        "opaque-continuity",
        ingress({ delivery_id: "delivery-after-success" }),
      ),
    );
    expect(afterSuccess.status).toBe(200);
    const afterSuccessBody = (await afterSuccess.json()) as TriggerResponse;
    expect(afterSuccessBody.workflow_run_ids).toHaveLength(3);
    await waitUntil(async () => {
      const statuses = await Promise.all(
        (afterSuccessBody.workflow_run_ids ?? []).map(
          async (id) => await fixture.workflowRuns.getStatus(id),
        ),
      );
      return statuses.every((status) => status?.status === "completed");
    });
  } finally {
    gate.resolve();
    fixture.close();
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("detached Codex sweep failure is retained in workflow run status", async () => {
  const fixture = await makeFixture([{ name: "session-memory-sweep", events: ["stop"] }]);
  fixture.state.failNames.add("session-memory-sweep");
  try {
    const response = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        fixture.root,
        "stop",
        "opaque-failure",
        ingress({ delivery_id: "delivery-failure" }),
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as TriggerResponse;
    expect(body.workflow_run_ids).toHaveLength(1);
    const runId = body.workflow_run_ids?.[0];
    expect(runId).toBeString();
    await waitUntil(
      async () => (await fixture.workflowRuns.getStatus(runId ?? ""))?.status === "failed",
    );
    expect(await fixture.workflowRuns.getStatus(runId ?? "")).toMatchObject({ status: "failed" });

    fixture.state.failNames.delete("session-memory-sweep");
    const afterFailure = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        fixture.root,
        "stop",
        "opaque-failure",
        ingress({ delivery_id: "delivery-after-failure" }),
      ),
    );
    expect(afterFailure.status).toBe(200);
    const afterFailureBody = (await afterFailure.json()) as TriggerResponse;
    expect(afterFailureBody.workflow_run_ids).toHaveLength(1);
    await waitUntil(
      async () =>
        (await fixture.workflowRuns.getStatus(afterFailureBody.workflow_run_ids?.[0] ?? ""))
          ?.status === "completed",
    );
    expect(fixture.state.calls.map((call) => call.name)).toEqual([
      "session-memory-sweep",
      "session-memory-sweep",
    ]);
  } finally {
    fixture.close();
  }
});

test("malformed Codex ingress fails before telemetry or workflow execution", async () => {
  const fixture = await makeFixture([
    { name: "maestro-context-prime", events: ["session-start"], reminder: true },
  ]);
  try {
    const response = await fixture.post(
      "/workflows/trigger",
      triggerBody(
        fixture.root,
        "session-start",
        "opaque-malformed",
        ingress({ role: "owner", delivery_id: "delivery-malformed" }),
      ),
    );
    expect(response.status).toBe(400);
    expect(fixture.state.calls).toHaveLength(0);
    expect(
      fixture.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_events").get()
        ?.count,
    ).toBe(0);
  } finally {
    fixture.close();
  }
});

test("authenticated observations persist Codex source, maestro origin and semantic tool activity", async () => {
  const fixture = await makeFixture([]);
  try {
    const response = await fixture.post("/observations", {
      ts: "2026-09-12T12:00:00.000Z",
      source: "codex",
      source_detail: "tool:apply_patch",
      project_id: "codex-hook-project",
      user_id: "codex",
      machine_id: "local",
      session_id: "opaque-root",
      event_type: "agent-tool-use",
      lane: "cli-subscription",
      request_id: "tool-use-1",
      payload_json: {
        tool: "apply_patch",
        input: { patch: "*** Begin Patch" },
        tool_activity: "edit",
      },
      payload_summary: "apply_patch",
      origin: "maestro",
    });
    expect(response.status).toBe(200);
    const row = fixture.db
      .query<
        {
          source: string;
          origin: string;
          session_id: string;
          payload_json: string;
        },
        []
      >(
        `SELECT source, origin, session_id, payload_json
           FROM t0_events
          WHERE request_id = 'tool-use-1'`,
      )
      .get();
    expect(row).toMatchObject({
      source: "codex",
      origin: "maestro",
      session_id: "opaque-root",
    });
    expect(JSON.parse(row?.payload_json ?? "{}")).toMatchObject({
      tool: "apply_patch",
      tool_activity: "edit",
    });
  } finally {
    fixture.close();
  }
});
