import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { chainsStartRoute, chainStartFromInput } from "@src/routes/chains.js";
import { handoffsGetRoute } from "@src/routes/handoffs.js";
import { createDaemonFetchHandler } from "@src/serve.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

const execFile = promisify(execFileCb);

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const SHARED_TOKEN = "shared-sec";

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return stdout.trim();
}

type ChainBody = {
  ok?: boolean;
  handoff_id?: string;
  conversation_id?: string;
  error?: { code?: string; reason?: string; parent_cwd_override?: string | null };
};

let services: Services;
let db: Database;
let repoDir: string;
let scratchBase: string;
let sha: string;
const RUN_ID = "run-scratch-1";

function seedWorker(workerId: string, metadata: Record<string, unknown>): void {
  const now = Date.now();
  db.run(
    `INSERT INTO worker_tokens (token_hash, worker_id, issued_at, last_seen_at, revoked_at, metadata_json)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    [`th-${workerId}`, workerId, now - 60_000, now, JSON.stringify(metadata)],
  );
}

// review_adversarial + use_worktree:false defaults permission_profile to
// review_readonly, so a production-shaped worker declares both capabilities.
function seedScratchCapableWorker(workerId = "w-scratch"): void {
  seedWorker(workerId, {
    supports_scratch_worktrees: true,
    enforces_permission_profiles: ["review_readonly"],
  });
}

function seedProfileCapableWorker(workerId = "w-profile"): void {
  seedWorker(workerId, { enforces_permission_profiles: ["review_readonly"] });
}

async function makeScratch(runId: string): Promise<string> {
  const wtPath = path.join(scratchBase, `.scratch-${runId}`);
  await git(repoDir, ["worktree", "add", "--detach", wtPath, sha]);
  const gitDirFile = fs.readFileSync(path.join(wtPath, ".git"), "utf8").trim();
  const gitDir = gitDirFile.slice("gitdir:".length).trim();
  const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(wtPath, gitDir);
  fs.writeFileSync(
    path.join(absGitDir, "penumbra-scratch.json"),
    `${JSON.stringify({ owner_run_id: runId, sha, created_at: new Date().toISOString() })}\n`,
  );
  return wtPath;
}

function wireRuntimeStubs(s: Services): void {
  s.watchdog = {
    recordHeartbeat: (): void => undefined,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  s.agentchatConfig = {
    agents: [
      {
        name: "codex",
        roles: [],
        adapter: "stdio-acp",
        enforces_permission_profiles: ["review_readonly"],
      },
    ],
  };
}

function buildTestServices(extra: Record<string, unknown> = {}): Services {
  let n = 0;
  const s = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/cwdovr-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-21T10:00:00Z"),
    uuid: () => `e-${String(++n)}`,
    mainRepoDir: fs.realpathSync(repoDir),
    worktreeRootDir: scratchBase,
    ...extra,
  });
  wireRuntimeStubs(s);
  return s;
}

beforeEach(async () => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-cwdovr-repo-"));
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.email", "test@example.com"]);
  await git(repoDir, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "init"]);
  sha = await git(repoDir, ["rev-parse", "HEAD"]);
  scratchBase = `${fs.realpathSync(repoDir)}-worktrees`;
  fs.mkdirSync(scratchBase, { recursive: true });

  services = buildTestServices();
});

afterEach(() => {
  fs.rmSync(`${repoDir}-alias`, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(scratchBase, { recursive: true, force: true });
  db.close();
});

function scratchStart(
  cwdOverride: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    initial_agent: "codex",
    message: "review",
    use_worktree: false,
    dispatch_kind: "workflow",
    workflow_run_id: RUN_ID,
    task_type: "review_adversarial",
    cwd_override: cwdOverride,
    ...extra,
  };
}

describe("chain_start cwd_override boundary", () => {
  test("the HTTP route rejects cwd_override outright", async () => {
    const wtPath = await makeScratch(RUN_ID);
    const res = await chainsStartRoute(
      new Request("http://x/chains/start", {
        method: "POST",
        body: JSON.stringify(scratchStart(wtPath)),
      }),
      services,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ChainBody;
    expect(body.error?.code).toBe("cwd_override_not_allowed");
  });

  test("chainStartFromInput rejects cwd_override without the in-process flag", async () => {
    const wtPath = await makeScratch(RUN_ID);
    const res = await chainStartFromInput(scratchStart(wtPath), services);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ChainBody;
    expect(body.error?.code).toBe("cwd_override_not_allowed");
  });

  test("cwd_override requires use_worktree:false + dispatch_kind workflow + workflow_run_id", async () => {
    const wtPath = await makeScratch(RUN_ID);
    // Reach the cwd_override gate: profile gate needs a live capable worker.
    seedScratchCapableWorker();
    for (const bad of [
      { use_worktree: undefined },
      { dispatch_kind: undefined },
      { workflow_run_id: undefined },
      { use_worktree: true },
    ]) {
      const input = scratchStart(wtPath);
      for (const key of Object.keys(bad)) {
        input[key] = (bad as Record<string, unknown>)[key];
      }
      const res = await chainStartFromInput(input, services, { allowCwdOverride: true });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ChainBody;
      expect(body.error?.code).toBe("cwd_override_requires_workflow_dispatch");
    }
  });

  test("a path that is not the run's daemon-owned scratch is rejected", async () => {
    seedScratchCapableWorker();
    const res = await chainStartFromInput(scratchStart(fs.realpathSync(repoDir)), services, {
      allowCwdOverride: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ChainBody;
    expect(body.error?.code).toBe("invalid_scratch_cwd_override");
  });

  test("a scratch bound to a different run id is rejected", async () => {
    seedScratchCapableWorker();
    const wtPath = await makeScratch("run-other");
    const res = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ChainBody;
    expect(body.error?.code).toBe("invalid_scratch_cwd_override");
  });

  test("a valid scratch with zero scratch-capable workers gets a 503 gate", async () => {
    const wtPath = await makeScratch(RUN_ID);
    // Profile-capable but not scratch-capable: isolates the scratch gate.
    seedProfileCapableWorker();
    const res = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ChainBody;
    expect(body.error?.code).toBe("scratch_capable_worker_unavailable");
  });

  test("a stale scratch-capable worker does not satisfy the gate", async () => {
    const wtPath = await makeScratch(RUN_ID);
    seedProfileCapableWorker();
    const stale = Date.now() - 10 * 60_000;
    db.run(
      `INSERT INTO worker_tokens (token_hash, worker_id, issued_at, last_seen_at, revoked_at, metadata_json)
       VALUES ('th-stale', 'w-stale', ?, ?, NULL, ?)`,
      [stale - 60_000, stale, JSON.stringify({ supports_scratch_worktrees: true })],
    );
    const res = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    expect(res.status).toBe(503);
  });

  test("happy path: valid scratch + capable worker persists cwd_override atomically", async () => {
    const wtPath = await makeScratch(RUN_ID);
    seedScratchCapableWorker();
    // Feed the override through a symlinked spelling of the fleet base (on
    // every platform, not only where tmpdir is itself a symlink) — the stored
    // value must be the canonical realpath the worker validates.
    const aliasBase = `${repoDir}-alias`;
    fs.symlinkSync(path.dirname(wtPath), aliasBase);
    const aliasOverride = path.join(aliasBase, path.basename(wtPath));
    expect(aliasOverride).not.toBe(fs.realpathSync(wtPath));

    const emitted: { cwd_override?: string | null }[] = [];
    const unsubscribe = services.handoffEvents.subscribe((row) => {
      emitted.push(row);
    });
    const res = await chainStartFromInput(scratchStart(aliasOverride), services, {
      allowCwdOverride: true,
    });
    unsubscribe();
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChainBody;
    const row = services.db
      .query<
        { cwd_override: string | null; use_worktree: number | null },
        [string]
      >("SELECT cwd_override, use_worktree FROM handoffs WHERE handoff_id = ?")
      .get(body.handoff_id!);
    expect(row?.cwd_override).toBe(fs.realpathSync(wtPath));
    expect(row?.use_worktree).toBe(0);

    // The SSE-emitted row is what a claiming worker dispatches — it must carry
    // the same realpath, not the pre-validation spelling.
    const emittedRow = emitted.find(
      (r) => (r as { handoff_id?: string }).handoff_id === body.handoff_id,
    );
    expect(emittedRow?.cwd_override).toBe(fs.realpathSync(wtPath));

    // GET consumers observe the routing immediately — the value lands in the
    // handoffs INSERT, not a post-hoc UPDATE.
    const get = handoffsGetRoute(new Request("http://x"), body.handoff_id!, services);
    const getBody = (await get.json()) as { handoff: { cwd_override?: string | null } };
    expect(getBody.handoff.cwd_override).toBe(fs.realpathSync(wtPath));
  });
});

describe("chain_start cwd_override hop rejection", () => {
  test("any child of a scratch-bound handoff is rejected, whether or not it repeats the override", async () => {
    const wtPath = await makeScratch(RUN_ID);
    seedScratchCapableWorker();
    const parent = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    expect(parent.status).toBe(200);
    const parentBody = (await parent.json()) as ChainBody;

    // Hop carrying no override — still rejected: scratch dispatches pin
    // max_hops:1, and a child row would lack the run-id binding the worker
    // validator requires.
    const hop = await chainStartFromInput(
      {
        initial_agent: "codex",
        message: "hop",
        parent_handoff_id: parentBody.handoff_id,
        use_worktree: false,
        dispatch_kind: "workflow",
        workflow_run_id: RUN_ID,
      },
      services,
      { allowCwdOverride: true },
    );
    expect(hop.status).toBe(400);
    const hopBody = (await hop.json()) as ChainBody;
    expect(hopBody.error?.code).toBe("cwd_override_parent_scratch");

    // Hop repeating the same override is rejected too.
    const repeat = await chainStartFromInput(
      {
        initial_agent: "codex",
        message: "hop",
        parent_handoff_id: parentBody.handoff_id,
        use_worktree: false,
        dispatch_kind: "workflow",
        workflow_run_id: RUN_ID,
        cwd_override: wtPath,
      },
      services,
      { allowCwdOverride: true },
    );
    expect(repeat.status).toBe(400);
    const repeatBody = (await repeat.json()) as ChainBody;
    expect(repeatBody.error?.code).toBe("cwd_override_parent_scratch");
  });
});

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input as string, init))) as typeof fetch;
}

describe("handoffs create + claim cwd_override gating", () => {
  async function createViaHandoffsRoute(input: Record<string, unknown>): Promise<Response> {
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    return await fetchHandler(
      new Request("http://x/handoffs", {
        method: "POST",
        headers: { authorization: `Bearer ${SHARED_TOKEN}` },
        body: JSON.stringify(input),
      }),
    );
  }

  test("the create route rejects children of scratch-bound parents and direct cwd_override", async () => {
    const wtPath = await makeScratch(RUN_ID);
    seedScratchCapableWorker();
    const parent = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    const parentBody = (await parent.json()) as ChainBody;

    const child = await createViaHandoffsRoute({
      from: "codex",
      to: "codex",
      message: "hop",
      conversation_id: parentBody.conversation_id,
      parent_handoff_id: parentBody.handoff_id,
      triggered_by_event_id: "evt-1",
    });
    expect(child.status).toBe(400);
    const childBody = (await child.json()) as ChainBody;
    expect(childBody.error?.code).toBe("cwd_override_parent_scratch");

    const direct = await createViaHandoffsRoute({
      from: "codex",
      to: "codex",
      message: "hop",
      conversation_id: parentBody.conversation_id,
      cwd_override: wtPath,
      triggered_by_event_id: "evt-2",
    });
    expect(direct.status).toBe(400);
    const directBody = (await direct.json()) as ChainBody;
    expect(directBody.error?.code).toBe("cwd_override_not_allowed");
  });

  test("claim rejects a worker without scratch support and admits one with it", async () => {
    const wtPath = await makeScratch(RUN_ID);
    seedScratchCapableWorker("w-scratch");
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const started = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    const startedBody = (await started.json()) as ChainBody;
    const handoffId = startedBody.handoff_id!;
    // Workflow dispatches are auto-approved at start — claimable directly.

    // Worker WITHOUT scratch capability (but with profile enforcement so the
    // profile claim gate isn't the one that refuses) is rejected.
    const { worker_token: plainToken } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "w-plain",
      metadata: { enforces_permission_profiles: ["review_readonly"] },
      fetcher: makeFetcher(fetchHandler),
    });
    const denied = await fetchHandler(
      new Request(`http://x/handoffs/${handoffId}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${plainToken}` },
        body: JSON.stringify({ worker_id: "w-plain" }),
      }),
    );
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as ChainBody;
    expect(deniedBody.error?.code).toBe("scratch_worker_not_capable");

    // Worker WITH scratch capability claims.
    const { worker_token: scratchToken } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "w-scratch",
      metadata: {
        supports_scratch_worktrees: true,
        enforces_permission_profiles: ["review_readonly"],
      },
      fetcher: makeFetcher(fetchHandler),
    });
    const claimed = await fetchHandler(
      new Request(`http://x/handoffs/${handoffId}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${scratchToken}` },
        body: JSON.stringify({ worker_id: "w-scratch" }),
      }),
    );
    expect(claimed.status).toBe(200);
  });

  async function startScratchHandoff(): Promise<{ fetchHandler: typeof fetch; handoffId: string }> {
    const wtPath = await makeScratch(RUN_ID);
    seedScratchCapableWorker();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const started = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    const startedBody = (await started.json()) as ChainBody;
    return { fetchHandler: makeFetcher(fetchHandler), handoffId: startedBody.handoff_id! };
  }

  test("the claim gate reads the presenting token's registration, not the worker's newest", async () => {
    const { fetchHandler, handoffId } = await startScratchHandoff();

    // Same worker, two registrations: the older token declared scratch
    // support, the newer one does not. A gate keyed on the newest row would
    // refuse this claim; the presenting token's own row is what counts.
    const { worker_token: capableToken } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "w-rot",
      metadata: {
        supports_scratch_worktrees: true,
        enforces_permission_profiles: ["review_readonly"],
      },
      fetcher: fetchHandler,
    });
    await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "w-rot",
      metadata: { enforces_permission_profiles: ["review_readonly"] },
      fetcher: fetchHandler,
    });
    // Pin the non-scratch row as "newest": the claim's auth touch updates the
    // presenting token, so without a pinned future timestamp the newest-row
    // lookup would coincidentally read the presented token anyway.
    services.db.run(
      `UPDATE worker_tokens SET last_seen_at = ?
        WHERE worker_id = ? AND metadata_json NOT LIKE '%supports_scratch_worktrees%'`,
      [Date.now() + 60_000, "w-rot"],
    );

    const claimed = await fetchHandler(
      new Request(`http://x/handoffs/${handoffId}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${capableToken}` },
        body: JSON.stringify({ worker_id: "w-rot" }),
      }),
    );
    expect(claimed.status).toBe(200);
  });

  test("an older token without scratch support cannot claim after the worker re-registers with it", async () => {
    const { fetchHandler, handoffId } = await startScratchHandoff();

    // Presenting token predates the capability: a newest-row gate would let
    // this claim through on the strength of the newer registration.
    const { worker_token: staleToken } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "w-rot2",
      metadata: { enforces_permission_profiles: ["review_readonly"] },
      fetcher: fetchHandler,
    });
    await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "w-rot2",
      metadata: {
        supports_scratch_worktrees: true,
        enforces_permission_profiles: ["review_readonly"],
      },
      fetcher: fetchHandler,
    });
    services.db.run(
      `UPDATE worker_tokens SET last_seen_at = ?
        WHERE worker_id = ? AND metadata_json LIKE '%supports_scratch_worktrees%'`,
      [Date.now() + 60_000, "w-rot2"],
    );

    const denied = await fetchHandler(
      new Request(`http://x/handoffs/${handoffId}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${staleToken}` },
        body: JSON.stringify({ worker_id: "w-rot2" }),
      }),
    );
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as ChainBody;
    expect(deniedBody.error?.code).toBe("scratch_worker_not_capable");
  });
});

describe("chain_start cwd_override project derivation", () => {
  let repo2Dir: string;
  let repo2Base: string;
  let repo3Dir: string;
  let repo3Base: string;
  const temps: string[] = [];

  async function initRepo(dir: string): Promise<string> {
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "test"]);
    fs.writeFileSync(path.join(dir, "README.md"), "# t\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-m", "init"]);
    return await git(dir, ["rev-parse", "HEAD"]);
  }

  async function makeScratchIn(repo: string, base: string, runId: string): Promise<string> {
    const head = await git(repo, ["rev-parse", "HEAD"]);
    const wtPath = path.join(base, `.scratch-${runId}`);
    await git(repo, ["worktree", "add", "--detach", wtPath, head]);
    const gitDirFile = fs.readFileSync(path.join(wtPath, ".git"), "utf8").trim();
    const gitDir = gitDirFile.slice("gitdir:".length).trim();
    const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(wtPath, gitDir);
    fs.writeFileSync(
      path.join(absGitDir, "penumbra-scratch.json"),
      `${JSON.stringify({ owner_run_id: runId, sha: head, created_at: new Date().toISOString() })}\n`,
    );
    return wtPath;
  }

  beforeEach(async () => {
    repo2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-cwdovr-proj2-"));
    repo3Dir = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-cwdovr-foreign-"));
    temps.push(repo2Dir, repo3Dir);
    await initRepo(repo2Dir);
    await initRepo(repo3Dir);
    repo2Base = `${fs.realpathSync(repo2Dir)}-worktrees`;
    repo3Base = `${fs.realpathSync(repo3Dir)}-worktrees`;
    fs.mkdirSync(repo2Base, { recursive: true });
    fs.mkdirSync(repo3Base, { recursive: true });
  });

  afterEach(() => {
    for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
    for (const b of [repo2Base, repo3Base]) fs.rmSync(b, { recursive: true, force: true });
  });

  function registryFor(): ProjectRegistry {
    return new ProjectRegistry(
      new Map([["proj-two", { project_id: "proj-two", root_path: fs.realpathSync(repo2Dir) }]]),
    );
  }

  test("a scratch on a second registered project derives project_id from its common dir", async () => {
    services = buildTestServices({ projectRegistry: registryFor() });
    const wtPath = await makeScratchIn(repo2Dir, repo2Base, RUN_ID);
    seedScratchCapableWorker();
    // No project_id on the request — the override's git lineage supplies it.
    const res = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChainBody;
    const row = services.db
      .query<
        { project_id: string | null },
        [string]
      >("SELECT project_id FROM handoffs WHERE handoff_id = ?")
      .get(body.handoff_id!);
    expect(row?.project_id).toBe("proj-two");
  });

  test("a dropped unknown project_id recovers via derivation on a workflow hop", async () => {
    services = buildTestServices({ projectRegistry: registryFor() });
    services.workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-1",
      clock: () => new Date("2026-05-21T10:00:00Z"),
      db,
      storageRoot: "/tmp/cwdovr-test",
    });
    // The run's recorded project is the synthetic git id the caller ran under
    // — equal to the request's project_id, so the bypass applies and the
    // unknown id is dropped; derivation must re-pin the real one.
    const runId = services.workflowRuns.register("wf", "synthetic-git-id")!;
    const wtPath = await makeScratchIn(repo2Dir, repo2Base, runId);
    seedScratchCapableWorker();
    const res = await chainStartFromInput(
      {
        ...scratchStart(wtPath),
        workflow_run_id: runId,
        project_id: "synthetic-git-id",
      },
      services,
      { allowCwdOverride: true },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChainBody;
    const row = services.db
      .query<
        { project_id: string | null },
        [string]
      >("SELECT project_id FROM handoffs WHERE handoff_id = ?")
      .get(body.handoff_id!);
    expect(row?.project_id).toBe("proj-two");
  });

  test("a scratch on an unregistered repo fails closed with a distinct reason", async () => {
    services = buildTestServices({ projectRegistry: registryFor() });
    const wtPath = await makeScratchIn(repo3Dir, repo3Base, RUN_ID);
    seedScratchCapableWorker();
    const res = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ChainBody;
    expect(body.error?.code).toBe("scratch_cwd_unknown_project");
  });

  test("a scratch on the daemon main repo still validates with a registry present", async () => {
    services = buildTestServices({ projectRegistry: registryFor() });
    const wtPath = await makeScratch(RUN_ID);
    seedScratchCapableWorker();
    const res = await chainStartFromInput(scratchStart(wtPath), services, {
      allowCwdOverride: true,
    });
    expect(res.status).toBe(200);
  });
});
