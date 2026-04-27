import { WorktreeManager, type WorktreeHandle } from '../worktree/manager.js';
import type { AgentChatConfig } from '../config/types.js';

const worktreeManager = new WorktreeManager();

export async function applyWorktreeOverride(
  handoff: any,
  config: AgentChatConfig,
  storageRoot: string
): Promise<{ overrideConfig: AgentChatConfig; handle: WorktreeHandle | null }> {
  const targetAgent = config.agents.find((a) => a.name === handoff.to_agent);
  const useWorktree = handoff.use_worktree ?? true;
  const isCliAdapter = targetAgent && ['claude-cli', 'gemini-cli', 'codex-cli', 'opencode-cli'].includes(targetAgent.adapter);

  if (useWorktree && isCliAdapter) {
    const handle = await worktreeManager.createWorktree(handoff.handoff_id as string);
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
    return { overrideConfig, handle };
  }

  return { overrideConfig: config, handle: null };
}
