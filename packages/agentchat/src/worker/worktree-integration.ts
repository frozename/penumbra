import type { WorktreeHandle, WorktreeManager } from "@penumbra/core";

import type { AgentChatConfig } from "../config/types.js";

export interface WorktreePromptRewrite {
  mainRepoPath: string;
  worktreePath: string;
  guardText: string;
}

export interface WorktreeOverrideResult {
  overrideConfig: AgentChatConfig;
  handle: WorktreeHandle | null;
  worktreePromptRewrite: WorktreePromptRewrite | null;
}

export interface WorktreeSetupContext {
  signal?: AbortSignal;
}

export interface WorktreeOverrideDeps {
  recordBranchName?: (handoffId: string, branchName: string) => Promise<void>;
}

/**
 * Subset of HandoffRow fields consumed by applyWorktreeOverride. Narrow shape
 * lets tests construct stub handoffs without filling every column on the full
 * row schema.
 */
export interface WorktreeOverrideHandoff {
  handoff_id: string;
  to_agent: string;
  use_worktree?: boolean | number | null;
  project_id?: string | null;
  branch_base?: string | null;
  isolated_install?: boolean | number | null;
}

export function rewriteWorktreeHandoffMessage(
  message: string,
  rewrite: WorktreePromptRewrite,
): string {
  const rewrittenMessage = message.split(rewrite.mainRepoPath).join(rewrite.worktreePath);
  return `${rewrittenMessage}\n\n${rewrite.guardText}`;
}

const WORKTREE_CAPABLE_ADAPTERS: ReadonlySet<string> = new Set([
  "claude-cli",
  // "agy-cli" is the kind the gemini/agy CLI agents (google-gemini-cli,
  // google-gemini-flash-cli, agy-gptoss-120b) actually register; without it a
  // use_worktree dispatch to those agents skips the cwd override and the CLI
  // runs in the worker's cwd (the MAIN checkout), contaminating it. "gemini-cli"
  // is vestigial (no agent registers that kind) but kept for compatibility.
  "gemini-cli",
  "agy-cli",
  "codex-cli",
  "opencode-cli",
  "stdio-acp",
  "opencode-acp",
]);

function resolveBaseRef(branch_base: string | null | undefined): string | undefined {
  return typeof branch_base === "string" && branch_base.length > 0 ? branch_base : undefined;
}

function resolveProjectRoot(
  manager: WorktreeManager,
  project_id: string | null | undefined,
): string | undefined {
  return manager.projectRootFor(project_id ?? undefined);
}

/**
 * Creates an isolated worktree for CLI-backed agents when the caller opts in.
 * Any failure is rethrown with the original exception preserved as `cause`,
 * even if the underlying throw value was not an `Error` instance.
 *
 * The caller MUST pass the same `WorktreeManager` instance used by the merge
 * reconciler — `WorktreeManager` keeps its handle map in memory, so two separate
 * instances can't see each other's worktrees and reconciliation will fail with
 * "Worktree for handoff X not found".
 */
export async function applyWorktreeOverride(
  handoff: WorktreeOverrideHandoff,
  config: AgentChatConfig,
  _storageRoot: string,
  worktreeManager: WorktreeManager,
  mainRepoPath = process.cwd(),
  setupContext?: WorktreeSetupContext,
  deps?: WorktreeOverrideDeps,
): Promise<WorktreeOverrideResult> {
  const targetAgent = config.agents.find((a) => a.name === handoff.to_agent);
  const useWorktree = handoff.use_worktree ?? true;
  // Adapters that honor `options.cwd` and therefore can run in an isolated
  // worktree. ACP adapters (stdio-acp, opencode-acp) take `cwd` the same way
  // as the *-cli adapters do; without them on this list, ACP dispatches with
  // use_worktree=true silently get no worktree, and worktree-scoped MCP tools
  // (fs.glob, fs.grep) fail with `not_found` even when the dispatch asked
  // for isolation. Surfaced by the Phase 1b.2 smoke test.
  if (useWorktree && targetAgent && WORKTREE_CAPABLE_ADAPTERS.has(targetAgent.adapter)) {
    return await createWorktreeOverride({
      handoff,
      config,
      worktreeManager,
      mainRepoPath,
      setupContext,
      targetAgent,
      deps,
    });
  }

  const projectRoot = resolveProjectRoot(worktreeManager, handoff.project_id);
  if (projectRoot !== undefined && targetAgent) {
    const overrideConfig: AgentChatConfig = {
      ...config,
      agents: config.agents.map((a) => {
        if (a.name !== targetAgent.name) return a;
        const baseOpts = a.options ?? {};
        return {
          ...a,
          options: { ...baseOpts, cwd: projectRoot, repoRoot: projectRoot },
        };
      }),
    };
    return { overrideConfig, handle: null, worktreePromptRewrite: null };
  }

  return { overrideConfig: config, handle: null, worktreePromptRewrite: null };
}

type AgentInConfig = AgentChatConfig["agents"][number];

interface CreateWorktreeOverrideArgs {
  handoff: WorktreeOverrideHandoff;
  config: AgentChatConfig;
  worktreeManager: WorktreeManager;
  mainRepoPath: string;
  setupContext: WorktreeSetupContext | undefined;
  targetAgent: AgentInConfig;
  deps: WorktreeOverrideDeps | undefined;
}

function gitHooksWarning(gitHooks: WorktreeHandle["gitHooks"]): string {
  if (gitHooks === undefined) return "";
  if (gitHooks.status !== "missing" && gitHooks.status !== "empty") return "";
  return (
    "\n\nGit hooks are NOT installed in this worktree " +
    `(core.hooksPath=${gitHooks.configured ?? ""} does not resolve to hooks here), ` +
    "so `git commit` will not run the repository's pre-commit checks. " +
    "Before each commit, run the repository's formatter and linter on the files you changed and fix what they report."
  );
}

async function createWorktreeOverride(
  args: CreateWorktreeOverrideArgs,
): Promise<WorktreeOverrideResult> {
  const { handoff, config, worktreeManager, mainRepoPath, setupContext, targetAgent, deps } = args;
  let handle: WorktreeHandle;
  try {
    handle = await worktreeManager.createWorktree(handoff.handoff_id, {
      baseRef: resolveBaseRef(handoff.branch_base),
      project_id: handoff.project_id ?? undefined,
      isolated_install: handoff.isolated_install === true || handoff.isolated_install === 1,
      signal: setupContext?.signal,
    });
  } catch (err) {
    throw new Error(
      `worktree creation failed for ${handoff.handoff_id}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : new Error(String(err)) },
    );
  }
  await deps?.recordBranchName?.(handoff.handoff_id, handle.branchName);

  const guardText =
    "This dispatch is isolated to the assigned worktree only.\n" +
    `Work only in: ${handle.path}\n` +
    "Do not read, edit, or commit in the shared main checkout.\n\n" +
    "When running pytest, pip, or any Python tool inside a git worktree, prepend `PYTHONPATH=$PWD` to the command. " +
    "A sibling checkout's .venv can otherwise shadow the worktree's source and make tests run against stale code. " +
    'If behavior looks wrong, verify imports with: python3 -c "import <pkg>; print(<pkg>.__file__)".' +
    gitHooksWarning(handle.gitHooks);

  const overrideConfig: AgentChatConfig = {
    ...config,
    agents: config.agents.map((a) => {
      if (a.name !== targetAgent.name) return a;
      const baseOpts = a.options ?? {};
      return {
        ...a,
        options: {
          ...baseOpts,
          cwd: handle.path,
          // Pool scope: stable across this project's per-handoff
          // worktrees so an ACP warm process is reused across them and
          // re-sessioned at each dispatch's cwd. Falls back to the main
          // repo path when the project root is unknown.
          repoRoot: resolveProjectRoot(worktreeManager, handoff.project_id) ?? mainRepoPath,
          env: { ...baseOpts.env, PENUMBRA_STORAGE_ROOT: handle.storageRoot },
        },
      };
    }),
  };

  return {
    overrideConfig,
    handle,
    worktreePromptRewrite: {
      mainRepoPath,
      worktreePath: handle.path,
      guardText,
    },
  };
}
