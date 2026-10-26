import type { RegistryReloadResult } from "./project-registry.js";

export interface AgentchatReloadDeps<TConfig extends { agents: readonly unknown[] }> {
  // Loads the new agentchat config and swaps it in; returns both sides so the
  // warm-pool invalidator can diff them.
  loadConfig: () => { previous: TConfig; next: TConfig };
  // Rebuilds values derived from the config (the worker's thoughts config,
  // #296). Runs synchronously right after the swap, before anything else
  // reads the new config.
  rebuildDerivedConfig: (next: TConfig) => void;
  invalidateWarmPools: (previous: TConfig, next: TConfig) => void;
  refreshPrewarm: () => void;
  projectRegistry: { reload: () => Promise<RegistryReloadResult> };
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

// Runs on the agentchat_reload control event. The config swap stays
// synchronous; the project-registry reload is scheduled without blocking the
// listener, and the prewarm refresh is deferred until the registry settles so
// the first pass after reload resolves current roots — including a failed
// reload, which still refreshes prewarm against the previous registry.
export function handleAgentchatReload<TConfig extends { agents: readonly unknown[] }>(
  deps: AgentchatReloadDeps<TConfig>,
): void {
  const { previous, next } = deps.loadConfig();
  deps.rebuildDerivedConfig(next);
  deps.invalidateWarmPools(previous, next);
  void deps.projectRegistry
    .reload()
    .then((result) => {
      if (result.ok) {
        deps.log.info(
          { project_count: result.count },
          "project-registry-reloaded-from-control-bus",
        );
      } else {
        deps.log.warn(
          { reason: result.reason },
          "project registry reload failed; keeping previous registry",
        );
      }
      deps.refreshPrewarm();
    })
    .catch((err: unknown) => {
      deps.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "project registry reload failed; keeping previous registry",
      );
      deps.refreshPrewarm();
    });
  deps.log.info({ agent_count: next.agents.length }, "agentchat-config-reloaded-from-control-bus");
}
