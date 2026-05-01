import type { WorktreeManager, WorktreeHandle } from '@penumbra/core';
import type { AgentChatConfig } from '../config/types.js';

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

export function rewriteWorktreeHandoffMessage(
  message: string,
  rewrite: WorktreePromptRewrite,
): string {
  const rewrittenMessage = message.split(rewrite.mainRepoPath).join(rewrite.worktreePath);
  return `${rewrittenMessage}\n\n${rewrite.guardText}`;
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
  handoff: any,
  config: AgentChatConfig,
  storageRoot: string,
  worktreeManager: WorktreeManager,
  mainRepoPath = process.cwd(),
): Promise<WorktreeOverrideResult> {
  const targetAgent = config.agents.find((a) => a.name === handoff.to_agent);
  const useWorktree = handoff.use_worktree ?? true;
  // Adapters that honor `options.cwd` and therefore can run in an isolated
  // worktree. ACP adapters (stdio-acp, opencode-acp) take `cwd` the same way
  // as the *-cli adapters do; without them on this list, ACP dispatches with
  // use_worktree=true silently get no worktree, and worktree-scoped MCP tools
  // (fs.glob, fs.grep) fail with `not_found` even when the dispatch asked
  // for isolation. Surfaced by the Phase 1b.2 smoke test.
  const isWorktreeCapableAdapter =
    targetAgent && ['claude-cli', 'gemini-cli', 'codex-cli', 'opencode-cli', 'stdio-acp', 'opencode-acp'].includes(targetAgent.adapter);

  if (useWorktree && isWorktreeCapableAdapter) {
    try {
      const handle = await worktreeManager.createWorktree(handoff.handoff_id as string);
      const guardText =
        'This dispatch is isolated to the assigned worktree only.\n' +
        `Work only in: ${handle.path}\n` +
        'Do not read, edit, or commit in the shared main checkout.';
      const overrideConfig: AgentChatConfig = {
        ...config,
        agents: config.agents.map((a) => {
          if (a.name === targetAgent.name) {
            const baseOpts = (a.options as any) ?? {};
            return {
              ...a,
              options: {
                ...baseOpts,
                cwd: handle.path,
                env: { ...baseOpts.env, PENUMBRA_STORAGE_ROOT: handle.storageRoot },
              },
            };
          }
          return a;
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
    } catch (err) {
      throw new Error(
        'worktree creation failed for ' +
          String(handoff.handoff_id) +
          ': ' +
          (err instanceof Error ? err.message : String(err)),
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
  }

  return { overrideConfig: config, handle: null, worktreePromptRewrite: null };
}
