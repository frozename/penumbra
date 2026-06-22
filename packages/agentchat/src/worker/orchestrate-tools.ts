/**
 * Tool surface for orchestrate-maestro dispatches.
 *
 * A dispatch with `dispatch_kind: "orchestrate"` runs a maestro agent that owns
 * a task-board task it must resolve when done (`task.complete` / `task.fail`),
 * reading its lease id first via `task.get`. Those tools are gated by the
 * adapter's `allowed_tools` surface (what the model is even shown) — see
 * agentchat-worker dispatch path — so they must be injected per-dispatch.
 *
 * Scoped to orchestrate dispatches ONLY (least privilege): regular implement/*
 * dispatches never gain task-mutation tools. The tools are themselves
 * lease-gated in the daemon (a worker can only resolve the task it holds the
 * open lease for), so the grant is safe even if a dispatch is mislabelled.
 */
export const ORCHESTRATE_MAESTRO_TOOLS = [
  "mcp__penumbra__task_get",
  "mcp__penumbra__task_complete",
  "mcp__penumbra__task_fail",
] as const;

/**
 * Return `allowedTools` augmented with the orchestrate-maestro tools iff the
 * dispatch is an orchestrate maestro. No-op (returns a copy) otherwise. Deduped
 * and order-stable (existing entries first, then any missing maestro tools).
 */
export function withOrchestrateTools(
  allowedTools: readonly string[],
  dispatchKind: string | null | undefined,
): string[] {
  if (dispatchKind !== "orchestrate") return [...allowedTools];
  const result = [...allowedTools];
  const seen = new Set(allowedTools);
  for (const tool of ORCHESTRATE_MAESTRO_TOOLS) {
    if (!seen.has(tool)) result.push(tool);
  }
  return result;
}

/**
 * Augment a single agent's `options.allowed_tools` in a config for an
 * orchestrate dispatch, leaving every other agent (and non-orchestrate
 * dispatches) untouched. Immutable — returns the same reference when there is
 * nothing to do, otherwise a shallow-cloned config with one rewritten agent.
 */
export function applyOrchestrateToolsToConfig<
  C extends { agents: { name: string; options?: Record<string, unknown> }[] },
>(config: C, agentName: string, dispatchKind: string | null | undefined): C {
  if (dispatchKind !== "orchestrate") return config;
  const state = { changed: false };
  const agents = config.agents.map((agent) => {
    if (agent.name !== agentName) return agent;
    const current = (agent.options?.allowed_tools as string[] | undefined) ?? [];
    const seen = new Set(current);
    const missing: string[] = [];
    for (const tool of ORCHESTRATE_MAESTRO_TOOLS) {
      if (!seen.has(tool)) missing.push(tool);
    }
    if (missing.length === 0) return agent;
    state.changed = true;
    return {
      ...agent,
      options: { ...(agent.options ?? {}), allowed_tools: [...current, ...missing] },
    };
  });
  return state.changed ? { ...config, agents } : config;
}
