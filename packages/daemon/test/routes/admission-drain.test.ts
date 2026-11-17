import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handoffsApproveRoute,
  handoffsCompleteRoute,
  handoffsCreateRoute,
} from "@src/routes/handoffs.js";
import { createDaemonFetchHandler } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const NOW = new Date("2026-11-17T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const TOKEN = "shared-sec";
const MINUTE_MS = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

interface DrainFlagFile {
  owner: string;
  reason: string;
  set_at: string;
  expires_at: string;
}

function flagPath(storageRoot: string): string {
  return join(storageRoot, "admission-drain.json");
}

function writeFlag(storageRoot: string, overrides: Partial<DrainFlagFile> = {}): DrainFlagFile {
  const flag: DrainFlagFile = {
    owner: overrides.owner ?? "deploy-a",
    reason: overrides.reason ?? "deploy",
    set_at: overrides.set_at ?? iso(NOW_MS - MINUTE_MS),
    expires_at: overrides.expires_at ?? iso(NOW_MS + 2 * MINUTE_MS),
  };
  writeFileSync(flagPath(storageRoot), JSON.stringify(flag));
  return flag;
}

interface TestContext {
  db: Database;
  storageRoot: string;
  services: Services;
  fetchHandler: (req: Request) => Promise<Response>;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function setup(): TestContext {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-admission-drain-"));
  const worktreeRootDir = join(storageRoot, "worktrees");
  mkdirSync(worktreeRootDir, { recursive: true });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot,
    worktreeRootDir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => NOW,
    uuid: () => `e-${String(++n)}`,
  });
  services.watchdog = {
    recordHeartbeat: (): void => undefined,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): never[] => [],
    getStaleHeartbeatAges: (): never[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  const fetchHandler = createDaemonFetchHandler({ services, token: TOKEN });
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
    rmSync(storageRoot, { recursive: true, force: true });
  });
  return { db, storageRoot, services, fetchHandler };
}

async function readBody<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function call(
  ctx: TestContext,
  method: string,
  routePath: string,
  requestBody?: unknown,
  opts: { auth?: boolean; token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== false) {
    headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  }
  return ctx.fetchHandler(
    new Request(`http://x${routePath}`, {
      method,
      headers,
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    }),
  );
}

interface DrainErrorBody {
  error?: { code?: string; retryable?: boolean };
  drain?: { owner?: string; expires_at?: string };
  retry_after_ms?: number;
}

interface DrainExpectation {
  owner: string;
  expires_at: string;
  retry_after_ms: number;
}

const ACTIVE_DRAIN: DrainExpectation = {
  owner: "deploy-a",
  expires_at: iso(NOW_MS + 2 * MINUTE_MS),
  retry_after_ms: 2 * MINUTE_MS,
};

async function expectAdmissionDraining(res: Response, expected: DrainExpectation): Promise<void> {
  expect(res.status).toBe(503);
  const parsed = await readBody<DrainErrorBody>(res);
  expect(parsed?.error?.code).toBe("admission_draining");
  expect(parsed?.error?.retryable).toBe(true);
  expect(parsed?.drain?.owner).toBe(expected.owner);
  expect(parsed?.drain?.expires_at).toBe(expected.expires_at);
  expect(parsed?.retry_after_ms).toBe(expected.retry_after_ms);
  expect(res.headers.get("retry-after")).toBe(String(expected.retry_after_ms / 1000));
}

function countHandoffRows(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs").get()?.n ?? 0;
}

function handoffStatus(db: Database, handoffId: string): string | null {
  return (
    db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id=?")
      .get(handoffId)?.status ?? null
  );
}

async function requireCreatedHandoffId(res: Response): Promise<string> {
  const parsed = await readBody<{ handoff_id?: string }>(res);
  if (res.status !== 200 || typeof parsed?.handoff_id !== "string") {
    throw new Error(`expected a created handoff, got HTTP ${String(res.status)}`);
  }
  return parsed.handoff_id;
}

async function createPendingHandoff(services: Services): Promise<string> {
  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "claude",
        to: "gemini",
        to_role: "executor",
        message: "go",
        conversation_id: "c-1",
        project_id: "auth-svc",
        triggered_by_event_id: "e",
      }),
    }),
    services,
  );
  return await requireCreatedHandoffId(res);
}

function approveRequest(handoffId: string, body: unknown = {}): Request {
  return new Request(`http://x/handoffs/${handoffId}/approve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function seedChainParent(services: Services, status: "dispatched" | "completed"): void {
  services.handoffWriter.createApproved({
    handoff_id: "h-parent",
    ts: "2026-11-17T11:59:00.000Z",
    project_id: null,
    conversation_id: "conv-chain",
    from: "user",
    to: "planner",
    to_role: null,
    message: "parent",
    triggered_by_event_id: "evt-parent",
    resolved_by: "chain-start",
    resolved_at: null,
    chain_max_hops: 3,
    chain_trust_mode: "all",
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
  });
  services.db.run("UPDATE handoffs SET status=? WHERE handoff_id=?", [status, "h-parent"]);
}

function chainChildCreateRequest(): Request {
  return new Request("http://x/handoffs", {
    method: "POST",
    body: JSON.stringify({
      from: "planner",
      to: "executor",
      message: "continue",
      conversation_id: "conv-chain",
      project_id: null,
      triggered_by_event_id: "evt-source-chain",
      parent_handoff_id: "h-parent",
      branch_base: "feat/round-one",
      chain_max_hops: 3,
    }),
  });
}

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req =
      typeof input === "string" || input instanceof URL
        ? new Request(input.toString(), init)
        : input;
    return handler(req);
  }) as typeof fetch;
}

test("active drain flag gates POST /chains/start", async () => {
  const ctx = setup();
  writeFlag(ctx.storageRoot);
  const before = countHandoffRows(ctx.db);
  const res = await call(ctx, "POST", "/chains/start", {
    initial_agent: "codex",
    message: "x",
    project_id: "penumbra",
  });
  await expectAdmissionDraining(res, ACTIVE_DRAIN);
  expect(countHandoffRows(ctx.db)).toBe(before);
});

const GATED_ADMISSION_ROUTES: [string, string, (storageRoot: string) => unknown][] = [
  [
    "POST /workflows/run",
    "/workflows/run",
    (storageRoot): unknown => ({ name: "x", cwd: storageRoot }),
  ],
  ["POST /maestro/sessions", "/maestro/sessions", (): unknown => ({})],
  ["POST /maestro/sessions/adhoc", "/maestro/sessions/adhoc", (): unknown => ({})],
  ["POST /long-lived/agent-x/tick", "/long-lived/agent-x/tick", (): unknown => ({})],
];

for (const [label, routePath, requestBody] of GATED_ADMISSION_ROUTES) {
  test(`active drain flag gates ${label}`, async () => {
    const ctx = setup();
    writeFlag(ctx.storageRoot);
    const res = await call(ctx, "POST", routePath, requestBody(ctx.storageRoot));
    await expectAdmissionDraining(res, ACTIVE_DRAIN);
  });
}

test("active drain flag gates handoffsCreateRoute", async () => {
  const ctx = setup();
  writeFlag(ctx.storageRoot);
  const res = await handoffsCreateRoute(
    new Request("http://x/handoffs", {
      method: "POST",
      body: JSON.stringify({
        from: "claude",
        to: "gemini",
        to_role: "executor",
        message: "go",
        conversation_id: "c-1",
        project_id: "auth-svc",
        triggered_by_event_id: "e",
      }),
    }),
    ctx.services,
  );
  await expectAdmissionDraining(res, ACTIVE_DRAIN);
  expect(countHandoffRows(ctx.db)).toBe(0);
});

test("active drain flag gates handoffsApproveRoute on a pending handoff", async () => {
  const ctx = setup();
  const id = await createPendingHandoff(ctx.services);
  writeFlag(ctx.storageRoot);
  const res = await handoffsApproveRoute(approveRequest(id), id, ctx.services);
  await expectAdmissionDraining(res, ACTIVE_DRAIN);
  expect(handoffStatus(ctx.db, id)).toBe("pending");
});

test("active drain flag exempts continuation of a dispatched chain", async () => {
  const ctx = setup();
  seedChainParent(ctx.services, "dispatched");
  writeFlag(ctx.storageRoot);
  const createRes = await handoffsCreateRoute(chainChildCreateRequest(), ctx.services);
  expect(createRes.status).toBe(200);
  const childId = await requireCreatedHandoffId(createRes);
  const approveRes = await handoffsApproveRoute(
    approveRequest(childId, { resolved_by: "auto" }),
    childId,
    ctx.services,
  );
  expect(approveRes.status).toBe(200);
  const approved = await readBody<{ status?: string }>(approveRes);
  expect(approved?.status).toBe("approved");
});

test("active drain flag gates children of a completed parent", async () => {
  const ctx = setup();
  seedChainParent(ctx.services, "completed");
  const createRes = await handoffsCreateRoute(chainChildCreateRequest(), ctx.services);
  expect(createRes.status).toBe(200);
  writeFlag(ctx.storageRoot);
  const childId = await requireCreatedHandoffId(createRes);
  const approveRes = await handoffsApproveRoute(approveRequest(childId), childId, ctx.services);
  await expectAdmissionDraining(approveRes, ACTIVE_DRAIN);
  expect(handoffStatus(ctx.db, childId)).toBe("pending");

  const secondCreate = await handoffsCreateRoute(chainChildCreateRequest(), ctx.services);
  await expectAdmissionDraining(secondCreate, ACTIVE_DRAIN);
});

test("GET /health exposes the active drain flag without auth", async () => {
  const ctx = setup();
  const flag = writeFlag(ctx.storageRoot);
  const res = await call(ctx, "GET", "/health", undefined, { auth: false });
  expect(res.status).toBe(200);
  const parsed = await readBody<{ admissionDrain?: unknown }>(res);
  expect(parsed?.admissionDrain).toEqual({
    draining: true,
    owner: flag.owner,
    reason: flag.reason,
    set_at: flag.set_at,
    expires_at: flag.expires_at,
    remaining_ms: 2 * MINUTE_MS,
  });
});

test("expired drain flag is reported stale and does not gate", async () => {
  const ctx = setup();
  const expiresAt = iso(NOW_MS - 1_000);
  const flag = writeFlag(ctx.storageRoot, { expires_at: expiresAt });
  const healthRes = await call(ctx, "GET", "/health", undefined, { auth: false });
  expect(healthRes.status).toBe(200);
  const health = await readBody<{
    admissionDrain?: { draining?: boolean; stale?: { owner?: string; expires_at?: string } };
  }>(healthRes);
  expect(health?.admissionDrain).toEqual({
    draining: false,
    stale: { owner: flag.owner, expires_at: expiresAt },
  });

  const res = await call(ctx, "POST", "/workflows/run", {});
  expect(res.status).not.toBe(503);
  const parsed = await readBody<{ error?: { code?: string } }>(res);
  expect(parsed?.error?.code).not.toBe("admission_draining");
});

test("drain TTL is clamped to 30 minutes from set_at", async () => {
  const ctx = setup();
  writeFlag(ctx.storageRoot, {
    set_at: iso(NOW_MS - MINUTE_MS),
    expires_at: iso(NOW_MS + 2 * 60 * MINUTE_MS),
  });
  const res = await call(ctx, "GET", "/health", undefined, { auth: false });
  expect(res.status).toBe(200);
  const parsed = await readBody<{
    admissionDrain?: {
      draining?: boolean;
      expires_at?: string;
      remaining_ms?: number;
    };
  }>(res);
  const clampedExpiresAt = iso(NOW_MS - MINUTE_MS + 30 * MINUTE_MS);
  expect(parsed?.admissionDrain?.draining).toBe(true);
  expect(parsed?.admissionDrain?.expires_at).toBe(clampedExpiresAt);
  expect(parsed?.admissionDrain?.remaining_ms).toBe(29 * MINUTE_MS);
});

test("drain TTL clamp expires a flag whose set_at is older than 30 minutes", async () => {
  const ctx = setup();
  writeFlag(ctx.storageRoot, {
    set_at: iso(NOW_MS - 31 * MINUTE_MS),
    expires_at: iso(NOW_MS + 60 * MINUTE_MS),
  });
  const res = await call(ctx, "GET", "/health", undefined, { auth: false });
  expect(res.status).toBe(200);
  const parsed = await readBody<{
    admissionDrain?: { draining?: boolean; stale?: { owner?: string } };
  }>(res);
  expect(parsed?.admissionDrain?.draining).toBe(false);
  expect(parsed?.admissionDrain?.stale?.owner).toBe("deploy-a");
});

test("malformed drain flag file is reported invalid", async () => {
  const ctx = setup();
  writeFileSync(flagPath(ctx.storageRoot), "not json");
  const res = await call(ctx, "GET", "/health", undefined, { auth: false });
  expect(res.status).toBe(200);
  const parsed = await readBody<{ admissionDrain?: unknown }>(res);
  expect(parsed?.admissionDrain).toEqual({ draining: false, invalid: true });
});

test("schema-invalid drain flag file is reported invalid", async () => {
  const ctx = setup();
  writeFileSync(
    flagPath(ctx.storageRoot),
    JSON.stringify({ owner: "", set_at: "yesterday", expires_at: 42 }),
  );
  const res = await call(ctx, "GET", "/health", undefined, { auth: false });
  expect(res.status).toBe(200);
  const parsed = await readBody<{ admissionDrain?: unknown }>(res);
  expect(parsed?.admissionDrain).toEqual({ draining: false, invalid: true });
  const run = await call(ctx, "POST", "/workflows/run", { name: "x", cwd: ctx.storageRoot });
  expect(run.status).not.toBe(503);
});

test("POST /admission/drain sets the flag and gates new work", async () => {
  const ctx = setup();
  const res = await call(ctx, "POST", "/admission/drain", {
    owner: "deploy-a",
    ttl_ms: MINUTE_MS,
    reason: "deploy",
  });
  expect(res.status).toBe(200);
  const parsed = await readBody<{
    draining?: boolean;
    owner?: string;
    reason?: string;
    set_at?: string;
    expires_at?: string;
    remaining_ms?: number;
  }>(res);
  expect(parsed?.draining).toBe(true);
  expect(parsed?.owner).toBe("deploy-a");
  expect(parsed?.reason).toBe("deploy");
  expect(parsed?.set_at).toBe(NOW.toISOString());
  expect(parsed?.expires_at).toBe(iso(NOW_MS + MINUTE_MS));
  expect(parsed?.remaining_ms).toBe(MINUTE_MS);
  expect(existsSync(flagPath(ctx.storageRoot))).toBe(true);

  const gated = await call(ctx, "POST", "/chains/start", {
    initial_agent: "codex",
    message: "x",
    project_id: "penumbra",
  });
  await expectAdmissionDraining(gated, {
    owner: "deploy-a",
    expires_at: iso(NOW_MS + MINUTE_MS),
    retry_after_ms: MINUTE_MS,
  });
});

test("POST /admission/drain validates ttl_ms above the 30 minute cap", async () => {
  const ctx = setup();
  const res = await call(ctx, "POST", "/admission/drain", {
    owner: "deploy-a",
    ttl_ms: 30 * MINUTE_MS + 1,
  });
  expect(res.status).toBe(400);
  const parsed = await readBody<{ error?: { code?: string } }>(res);
  expect(parsed?.error?.code).toBe("validation_error");
});

test("POST /admission/drain rejects a missing or empty owner", async () => {
  const ctx = setup();
  for (const body of [{}, { owner: "" }]) {
    const res = await call(ctx, "POST", "/admission/drain", body);
    expect(res.status).toBe(400);
    const parsed = await readBody<{ error?: { code?: string } }>(res);
    expect(parsed?.error?.code).toBe("validation_error");
  }
});

test("POST /admission/drain defaults ttl_ms to 10 minutes", async () => {
  const ctx = setup();
  const res = await call(ctx, "POST", "/admission/drain", { owner: "deploy-a" });
  expect(res.status).toBe(200);
  const parsed = await readBody<{ expires_at?: string; remaining_ms?: number }>(res);
  expect(parsed?.expires_at).toBe(iso(NOW_MS + 10 * MINUTE_MS));
  expect(parsed?.remaining_ms).toBe(10 * MINUTE_MS);
});

test("POST /admission/drain enforces single-owner admission", async () => {
  const ctx = setup();
  const setRes = await call(ctx, "POST", "/admission/drain", {
    owner: "deploy-a",
    ttl_ms: 2 * MINUTE_MS,
  });
  expect(setRes.status).toBe(200);

  const conflict = await call(ctx, "POST", "/admission/drain", { owner: "deploy-b" });
  expect(conflict.status).toBe(409);
  const conflictBody = await readBody<{
    error?: { code?: string };
    drain?: { owner?: string };
  }>(conflict);
  expect(conflictBody?.error?.code).toBe("admission_drain_owned");
  expect(conflictBody?.drain?.owner).toBe("deploy-a");
  const flagOnDisk = JSON.parse(readFileSync(flagPath(ctx.storageRoot), "utf8")) as {
    owner?: string;
  };
  expect(flagOnDisk.owner).toBe("deploy-a");

  const refresh = await call(ctx, "POST", "/admission/drain", {
    owner: "deploy-a",
    ttl_ms: 5 * MINUTE_MS,
  });
  expect(refresh.status).toBe(200);
  const refreshed = await readBody<{ expires_at?: string }>(refresh);
  expect(refreshed?.expires_at).toBe(iso(NOW_MS + 5 * MINUTE_MS));
});

test("expired drain flag can be taken over by another owner", async () => {
  const ctx = setup();
  writeFlag(ctx.storageRoot, {
    owner: "deploy-a",
    expires_at: iso(NOW_MS - 1_000),
  });
  const res = await call(ctx, "POST", "/admission/drain", { owner: "deploy-b" });
  expect(res.status).toBe(200);
  const parsed = await readBody<{ owner?: string; draining?: boolean }>(res);
  expect(parsed?.draining).toBe(true);
  expect(parsed?.owner).toBe("deploy-b");
  const flagOnDisk = JSON.parse(readFileSync(flagPath(ctx.storageRoot), "utf8")) as {
    owner?: string;
  };
  expect(flagOnDisk.owner).toBe("deploy-b");
});

test("POST /admission/drain/release is owner-controlled", async () => {
  const ctx = setup();
  writeFlag(ctx.storageRoot);

  const foreign = await call(ctx, "POST", "/admission/drain/release", { owner: "deploy-b" });
  expect(foreign.status).toBe(409);
  const foreignBody = await readBody<{ error?: { code?: string } }>(foreign);
  expect(foreignBody?.error?.code).toBe("admission_drain_owned");
  expect(existsSync(flagPath(ctx.storageRoot))).toBe(true);

  const released = await call(ctx, "POST", "/admission/drain/release", { owner: "deploy-a" });
  expect(released.status).toBe(200);
  const releasedBody = await readBody<{ draining?: boolean; released?: boolean }>(released);
  expect(releasedBody?.draining).toBe(false);
  expect(releasedBody?.released).toBe(true);
  expect(existsSync(flagPath(ctx.storageRoot))).toBe(false);

  const after = await call(ctx, "POST", "/chains/start", {
    initial_agent: "codex",
    message: "x",
    project_id: "penumbra",
  });
  expect(after.status).not.toBe(503);
  const afterBody = await readBody<{ error?: { code?: string } }>(after);
  expect(afterBody?.error?.code).not.toBe("admission_draining");
});

test("POST /admission/drain/release with no flag reports released false", async () => {
  const ctx = setup();
  const res = await call(ctx, "POST", "/admission/drain/release", { owner: "deploy-a" });
  expect(res.status).toBe(200);
  const parsed = await readBody<{ draining?: boolean; released?: boolean }>(res);
  expect(parsed?.draining).toBe(false);
  expect(parsed?.released).toBe(false);
});

test("POST /admission/drain/release removes an expired foreign flag", async () => {
  const ctx = setup();
  writeFlag(ctx.storageRoot, {
    owner: "deploy-a",
    expires_at: iso(NOW_MS - 1_000),
  });
  const res = await call(ctx, "POST", "/admission/drain/release", { owner: "deploy-b" });
  expect(res.status).toBe(200);
  const parsed = await readBody<{ draining?: boolean; released?: boolean }>(res);
  expect(parsed?.draining).toBe(false);
  expect(parsed?.released).toBe(true);
  expect(existsSync(flagPath(ctx.storageRoot))).toBe(false);
});

test("POST /admission/drain requires a bearer token", async () => {
  const ctx = setup();
  const res = await call(
    ctx,
    "POST",
    "/admission/drain",
    { owner: "deploy-a", ttl_ms: MINUTE_MS },
    { auth: false },
  );
  expect(res.status).toBe(401);
});

test("auth runs before the admission check", async () => {
  const ctx = setup();
  writeFlag(ctx.storageRoot);
  const authed = await call(ctx, "POST", "/workflows/run", { name: "x", cwd: ctx.storageRoot });
  expect(authed.status).toBe(503);
  const res = await call(
    ctx,
    "POST",
    "/workflows/run",
    { name: "x", cwd: ctx.storageRoot },
    { auth: false },
  );
  expect(res.status).toBe(401);
  const tick = await call(ctx, "POST", "/long-lived/home/tick", {}, { auth: false });
  expect(tick.status).toBe(401);
});

test("active drain flag still allows rejecting a pending handoff", async () => {
  const ctx = setup();
  const id = await createPendingHandoff(ctx.services);
  writeFlag(ctx.storageRoot);
  const res = await handoffsApproveRoute(
    approveRequest(id, { reject: true, reason: "r" }),
    id,
    ctx.services,
  );
  expect(res.status).toBe(200);
  const parsed = await readBody<{ status?: string }>(res);
  expect(parsed?.status).toBe("rejected");
});

test("in-flight handoff can still complete while draining", async () => {
  const ctx = setup();
  const id = await createPendingHandoff(ctx.services);
  const approveRes = await handoffsApproveRoute(approveRequest(id), id, ctx.services);
  expect(approveRes.status).toBe(200);
  ctx.services.handoffWriter.claimDispatch(id, "test-worker");
  writeFlag(ctx.storageRoot);
  const res = await handoffsCompleteRoute(
    new Request("http://x", { method: "POST" }),
    id,
    ctx.services,
  );
  expect(res.status).toBe(200);
  const parsed = await readBody<{ status?: string }>(res);
  expect(parsed?.status).toBe("completed");
});

test("pre-approved handoff can still be claimed while draining", async () => {
  const ctx = setup();
  const id = await createPendingHandoff(ctx.services);
  const approveRes = await handoffsApproveRoute(approveRequest(id), id, ctx.services);
  expect(approveRes.status).toBe(200);
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: TOKEN,
    worker_id: "test-worker",
    fetcher: makeFetcher(ctx.fetchHandler),
  });
  writeFlag(ctx.storageRoot);
  const res = await call(
    ctx,
    "POST",
    `/handoffs/${id}/claim`,
    { worker_id: "test-worker" },
    { token: worker_token },
  );
  expect(res.status).toBe(200);
  const parsed = await readBody<{ status?: string }>(res);
  expect(parsed?.status).toBe("dispatched");
});

test("POST /workflows/run without a drain flag behaves as at base", async () => {
  const ctx = setup();
  const res = await call(ctx, "POST", "/workflows/run", { name: "x", cwd: ctx.storageRoot });
  expect(res.status).toBe(500);
  const parsed = await readBody<{ error?: { code?: string } }>(res);
  expect(parsed?.error?.code).toBe("no_registry");
});
