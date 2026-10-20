import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
  type Watchdog,
  type WorktreeCommandRunner,
  type WorktreeHandle,
  WorktreeManager,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type WorktreeInspectionHarness = {
  root: string;
  repoRoot: string;
  services: Services;
  db: Database;
  gitEnv: NodeJS.ProcessEnv;
  cleanup(): void;
};

const TEST_TS = "2026-09-12T12:00:00.000Z";

export function controlledGitArgs(args: readonly string[]): string[] {
  return ["-c", "core.hooksPath=/dev/null", ...args];
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", controlledGitArgs(args), { cwd, encoding: "utf8", env });
}

function worktreeRunner(env: NodeJS.ProcessEnv): WorktreeCommandRunner {
  return async (command, args, opts) => {
    if (command !== "git") throw new Error(`unexpected fixture command: ${command}`);
    return await execFile(command, controlledGitArgs(args), {
      ...opts,
      encoding: opts?.encoding ?? "utf8",
      env,
    });
  };
}

export function createWorktreeInspectionHarness(): WorktreeInspectionHarness {
  const root = mkdtempSync(join(tmpdir(), "daemon-worktree-inspection-"));
  const repoRoot = join(root, "repo");
  const gitHome = join(root, "git-home");
  const gitConfigHome = join(root, "git-xdg");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(gitHome, { recursive: true });
  mkdirSync(gitConfigHome, { recursive: true });
  const gitEnv: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HOME: gitHome,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    XDG_CONFIG_HOME: gitConfigHome,
  };
  writeFileSync(join(repoRoot, ".penumbra-project"), "project-a\n");
  writeFileSync(join(repoRoot, "package.json"), '{"name":"inspection-fixture","private":true}\n');
  git(repoRoot, ["init", "-b", "main"], gitEnv);
  git(repoRoot, ["config", "user.email", "worktree-inspection@example.com"], gitEnv);
  git(repoRoot, ["config", "user.name", "Worktree Inspection Test"], gitEnv);
  writeFileSync(join(repoRoot, "base.txt"), "base\n");
  git(repoRoot, ["add", ".penumbra-project", "base.txt", "package.json"], gitEnv);
  git(repoRoot, ["commit", "-m", "base"], gitEnv);

  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const projectRegistry = new ProjectRegistry(
    new Map([
      ["project-a", { project_id: "project-a", root_path: repoRoot }],
      ["project-b", { project_id: "project-b", root_path: join(root, "foreign") }],
    ]),
  );
  let uuidCounter = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: join(root, "storage"),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(TEST_TS),
    uuid: () => `inspection-${String(++uuidCounter)}`,
    projectRegistry,
    mainRepoDir: repoRoot,
  });
  services.worktreeManager = new WorktreeManager({
    rootDir: join(root, "worktrees"),
    mainRepoDir: repoRoot,
    resolveProjectRoot: (projectId): string | undefined =>
      projectRegistry.get(projectId)?.root_path,
    resolveBranchName: (handoffId): string | null | undefined =>
      db
        .query<
          { branch_name: string | null },
          [string]
        >("SELECT branch_name FROM handoffs WHERE handoff_id = ?")
        .get(handoffId)?.branch_name,
    runner: worktreeRunner(gitEnv),
  });
  const watchdog: Watchdog = {
    recordHeartbeat: (): void => undefined,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  services.watchdog = watchdog;

  return {
    root,
    repoRoot,
    services,
    db,
    gitEnv,
    cleanup: (): void => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function createInspectionWorktree(
  harness: WorktreeInspectionHarness,
  input: {
    handoffId?: string;
    projectId?: string;
    branchName?: string;
    commit?: boolean;
  } = {},
): Promise<WorktreeHandle> {
  const handoffId = input.handoffId ?? "11111111-1111-4111-8111-111111111111";
  const projectId = input.projectId ?? "project-a";
  const branchName = input.branchName ?? `agent/${handoffId}`;
  harness.services.handoffWriter.createApproved({
    handoff_id: handoffId,
    ts: TEST_TS,
    project_id: projectId,
    conversation_id: `conversation-${handoffId}`,
    from: "user",
    to: "codex",
    to_role: null,
    message: `inspect ${handoffId}`,
    triggered_by_event_id: `event-${handoffId}`,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: 1,
    chain_trust_mode: "all",
    chain_task_type: "implement_small",
    use_worktree: true,
    parent_handoff_id: null,
    branch_base: "main",
    branch_name: branchName,
  });
  const handle = await harness.services.worktreeManager.createWorktree(handoffId, {
    project_id: projectId,
  });
  if (input.commit !== false) {
    writeFileSync(join(handle.path, "candidate.txt"), `candidate ${handoffId}\n`);
    git(handle.path, ["add", "candidate.txt"], harness.gitEnv);
    git(handle.path, ["commit", "-m", "candidate"], harness.gitEnv);
  }
  return handle;
}

export function seedInspectionHandoff(
  services: Services,
  input: { handoffId: string; projectId: string; branchName: string },
): void {
  services.handoffWriter.createApproved({
    handoff_id: input.handoffId,
    ts: TEST_TS,
    project_id: input.projectId,
    conversation_id: `conversation-${input.handoffId}`,
    from: "user",
    to: "codex",
    to_role: null,
    message: `inspect ${input.handoffId}`,
    triggered_by_event_id: `event-${input.handoffId}`,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: 1,
    chain_trust_mode: "all",
    chain_task_type: "implement_small",
    use_worktree: true,
    parent_handoff_id: null,
    branch_base: "main",
    branch_name: input.branchName,
  });
}

export function gitOutput(cwd: string, args: readonly string[]): string;
export function gitOutput(
  harness: WorktreeInspectionHarness,
  cwd: string,
  args: readonly string[],
): string;
export function gitOutput(
  harnessOrCwd: WorktreeInspectionHarness | string,
  cwdOrArgs: string | readonly string[],
  maybeArgs?: readonly string[],
): string {
  if (typeof harnessOrCwd === "string") {
    const cwd = harnessOrCwd;
    const args = cwdOrArgs as readonly string[];
    return git(cwd, args, {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      HOME: join(cwd, ".fixture-git-home"),
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      XDG_CONFIG_HOME: join(cwd, ".fixture-git-xdg"),
    });
  }
  return git(cwdOrArgs as string, maybeArgs ?? [], harnessOrCwd.gitEnv);
}
