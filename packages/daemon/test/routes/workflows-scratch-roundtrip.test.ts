import {
  buildServices,
  type HandoffRow,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildRegistry } from "@penumbra/workflows";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { workflowsRunRoute } from "@src/routes/workflows.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

const execFile = promisify(execFileCb);

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

// The workflow exercises the production scratch path end to end: acquire the
// run's detached scratch, dispatch a profiled persona into it via a SYMLINKED
// spelling of the path (the route must persist the canonical realpath), and
// deliberately never release — the run-settle backstop owns teardown.
const SCRATCH_WORKFLOW = `import { symlinkSync } from 'node:fs';
import type { WorkflowSpec, WorkflowFn } from '@penumbra/workflows';
const spec: WorkflowSpec = {
  name: 'scratch-roundtrip',
  description: 'acquires a scratch and dispatches into it',
  triggers: [{ kind: 'manual' }],
  recall: [],
  output: [],
  run: { kind: 'ts-function' },
};
export default spec;
export const fn: WorkflowFn = async (ctx) => {
  const raw = ctx as {
    scratchWorktree: {
      acquire(): Promise<{ path: string; sha: string; project_id: string | null }>;
    };
    dispatch(input: Record<string, unknown>): Promise<{ conversation_id: string; handoff_id: string }>;
  };
  const scratch = await raw.scratchWorktree.acquire();
  const linkPath = scratch.path + '-via-link';
  symlinkSync(scratch.path, linkPath);
  const dispatched = await raw.dispatch({
    agent: 'codex',
    message: 'scratch round trip',
    task_type: 'review_adversarial',
    task_class: 'TRIVIAL',
    permission_profile: 'review_readonly',
    use_worktree: false,
    max_hops: 1,
    cwd_override: linkPath,
    project_id: scratch.project_id,
  });
  return { scratch_path: scratch.path, link_path: linkPath, handoff_id: dispatched.handoff_id };
};
`;

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("daemon round trip: scratch acquire, cwd_override persists the realpath, settle releases", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-scratch-roundtrip-"));
  const realRoot = realpathSync(root);
  const scratchBase = `${realRoot}-worktrees`;
  try {
    await execFile("git", ["init", "-b", "main"], { cwd: root });
    await git(root, ["config", "user.email", "t@t"]);
    await git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "README.md"), "# scratch round trip\n");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "init"]);

    writeFileSync(join(root, ".penumbra-project"), "test-project\n");
    mkdirSync(join(root, "playbooks"), { recursive: true });
    mkdirSync(join(root, "workflows/scratch-roundtrip"), { recursive: true });
    writeFileSync(join(root, "workflows/scratch-roundtrip/workflow.ts"), SCRATCH_WORKFLOW);
    const registry = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });

    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const now = Date.now();
    db.run(
      `INSERT INTO worker_tokens (token_hash, worker_id, issued_at, last_seen_at, revoked_at, metadata_json)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [
        "th-w-scratch",
        "w-scratch",
        now - 60_000,
        now,
        JSON.stringify({
          supports_scratch_worktrees: true,
          enforces_permission_profiles: ["review_readonly"],
        }),
      ],
    );
    const workflowRuns = createWorkflowRunsRegistry({
      uuid: () => "wfrun-scratch",
      clock: () => new Date("2026-09-12T12:00:00.000Z"),
      db,
      storageRoot: root,
    });
    let uuidCounter = 0;
    const services: Services = buildServices({
      env: {},
      input: {},
      storageRoot: root,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: () => new Date("2026-09-12T12:00:00.000Z"),
      uuid: () => `rt-${String(++uuidCounter)}`,
      agentRegistry: ["codex"],
      projectRegistry: new ProjectRegistry(
        new Map([["test-project", { project_id: "test-project", root_path: realRoot }]]),
      ),
      workflowRegistry: registry,
      workflowRuns,
      mainRepoDir: realRoot,
      worktreeRootDir: scratchBase,
    });
    services.watchdog = {
      recordHeartbeat: (): void => undefined,
      hasActiveWorker: (): boolean => true,
      getStaleWorkers: (): string[] => [],
      getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
      tick: (): Promise<void> => Promise.resolve(),
    };
    services.agentchatConfig = {
      agents: [
        {
          name: "codex",
          adapter: "codex-cli",
          roles: [],
          enforces_permission_profiles: ["review_readonly"],
        },
      ],
    };

    const emitted: HandoffRow[] = [];
    const off = services.handoffEvents.subscribe((row) => {
      emitted.push(row);
    });
    try {
      const response = await workflowsRunRoute(
        new Request("http://localhost/workflows/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "scratch-roundtrip", cwd: root, wait: true }),
        }),
        services,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        outcome?: string;
        workflow_run_id?: string | null;
        runResult?: { scratch_path?: string; link_path?: string; handoff_id?: string };
      };
      expect(body.outcome).toBe("success");
      expect(body.workflow_run_id).toBe("wfrun-scratch");
      const scratchPath = body.runResult?.scratch_path;
      const linkPath = body.runResult?.link_path;
      const handoffId = body.runResult?.handoff_id;
      if (scratchPath === undefined || linkPath === undefined || handoffId === undefined) {
        throw new Error(`workflow did not report scratch dispatch: ${JSON.stringify(body)}`);
      }

      // The persisted row carries the canonical realpath, not the symlink the
      // workflow dispatched — the worker re-validates the stored string against
      // the on-disk owner marker.
      const row = db
        .query<
          { cwd_override: string | null; workflow_run_id: string | null },
          [string]
        >(`SELECT cwd_override, workflow_run_id FROM handoffs WHERE handoff_id = ?`)
        .get(handoffId);
      expect(row?.cwd_override).toBe(realpathSync(scratchPath));
      expect(row?.cwd_override).not.toBe(linkPath);
      expect(row?.workflow_run_id).toBe("wfrun-scratch");

      // The SSE-emitted row is the same payload the /handoffs/events stream
      // writes — it must carry the same canonical realpath.
      const sseRow = emitted.find((candidate) => candidate.handoff_id === handoffId);
      expect(sseRow?.cwd_override).toBe(realpathSync(scratchPath));

      // The workflow never released; the run-settle backstop tears the scratch
      // down so a plugin that forgets cannot leak a checkout until GC. Release
      // defers while the run's handoffs are non-terminal, so settle the
      // dispatched handoff the way a completing persona would.
      db.run(`UPDATE handoffs SET status = 'completed' WHERE handoff_id = ?`, [handoffId]);
      const released = await waitFor(() => !existsSync(scratchPath));
      expect(released).toBe(true);
      expect(services.scratchWorktrees.isLive("wfrun-scratch")).toBe(false);
    } finally {
      off();
      db.close();
    }
  } finally {
    rmSync(scratchBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
