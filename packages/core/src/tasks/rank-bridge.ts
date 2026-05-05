export type RankAgentsFn = (
  input: { prompt: string; tags?: string[] }
) => Promise<{ agent_name: string; score: number }[]>;
