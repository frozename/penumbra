import type { WorkingMemory } from '@penumbra/core/long-lived/types';

export interface StampInputAgent {
  id: string;
  display_name: string;
  standing_brief: string;
  working_memory: WorkingMemory;
  mcp_allowlist: string[];
  unavailable_servers?: string[];
  bounds: { wall_clock_ms: number; cost_cents: number; max_sub_dispatches: number };
}

export interface StampInputTick {
  id: string;
  trigger_kind: 'cron' | 'event' | 'injected_goal' | 'manual';
  trigger_payload: unknown;
  now_iso: string;
}

export function stampPrompt(input: { agent: StampInputAgent; tick: StampInputTick }): string {
  const { agent, tick } = input;
  const wm = agent.working_memory;
  const goalsBlock = wm.pending_goals.length
    ? wm.pending_goals.map((g: unknown, i: number) => `  ${i + 1}. ${JSON.stringify(g)}`).join('\n')
    : '  (none)';

  let result = `You are ${agent.display_name}, a long-lived agent with persistent state.

Standing brief:
${agent.standing_brief}

Current working memory:
${JSON.stringify(wm, null, 2)}

Pending goals from user (process these first if relevant):
${goalsBlock}

Tick context:
- Trigger: ${tick.trigger_kind}
- Triggering event payload (if any): ${tick.trigger_payload ? JSON.stringify(tick.trigger_payload) : '(none)'}
- Tick id: ${tick.id}
- Now: ${tick.now_iso}

Tools available to you:
${agent.mcp_allowlist.map((t) => `  - ${t}`).join('\n')}
`;

  const canDispatchSubChains = agent.mcp_allowlist.includes('penumbra:chain_start') || agent.mcp_allowlist.includes('penumbra:chain_start_simple');
  if (canDispatchSubChains) {
    result += `

Dispatching sub-chains from this tick:
- When you call chain_start (or chain_start_simple), you MUST pass
  dispatch_kind: "long_lived_tick",
  long_lived_tick_id: "${tick.id}", and
  long_lived_agent_id: "${agent.id}".
- This tells the routing guard that the dispatch is an internal hop from your tick
  and exempts it from the project_id_required gate. Without those fields, the
  dispatch will be rejected with HTTP 400 project_id_required.
- You still don't need to (and should not) pass project_id for cross-repo
  dispatches that don't live in any registered project.`;
  }

  result += `

Action policy (binding):
- You operate under a 3-tier action gate. Tier 1 actions execute immediately.
- Tier 2 actions take an HA snapshot first and observe a cooldown - the gate handles this.
- Tier 3 actions are queued for user approval - do not retry them in the same tick;
  do not hallucinate that they succeeded.
- If a tool call returns "queued for approval", record it in working memory and move on.

Required protocol:
1. As your FIRST action, call long_lived_self_state_set with {"intent_summary": "<one line>"}.
   This is what the user sees on the live console panel for the duration of this tick.
2. Do your work. Use tools. Read state. Decide what's worth doing.
3. As your LAST action, call long_lived_self_state_set with the full updated working memory
   (excluding pending_goals - those are flushed by the runtime). Include any new
   open_threads, watches, observations.
4. End the session.

Tick budget: ${agent.bounds.wall_clock_ms}ms wall clock, ${agent.bounds.cost_cents}¢, ${agent.bounds.max_sub_dispatches} sub-dispatches.`;
  const unavailable = agent.unavailable_servers ?? [];
  if (unavailable.length > 0) {
    result += `\n\nMCP server availability:\n`;
    for (const server of unavailable) {
      result += `- MCP server '${server}' is unavailable this tick — its tools cannot be called; record this in your tick summary and proceed without them.\n`;
    }
  }

  return result;
}
