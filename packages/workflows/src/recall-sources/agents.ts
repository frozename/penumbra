export type AgentsSourceInput = {
  agentRegistry?: { listAgents(): { name: string }[] };
};

export type AgentsSourceOutput = { agents: { name: string }[]; warnings: string[] };

export function runAgentsSource(input: AgentsSourceInput): AgentsSourceOutput {
  if (!input.agentRegistry) return { agents: [], warnings: ["agents: registry not provided"] };
  return { agents: input.agentRegistry.listAgents(), warnings: [] };
}
