import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { AgentRankInputSchema } from "@penumbra/core";

import type { DaemonClient } from "../daemon-client.js";

export { AgentRankInputSchema };
export const AgentRankInputShape = AgentRankInputSchema.shape;

export function agentRankHandler(daemon: Pick<DaemonClient, "agentRank">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = AgentRankInputSchema.parse(input ?? {});
    const out = await daemon.agentRank({
      task_type: parsed.task_type,
      since: parsed.since,
      min_samples: parsed.min_samples,
      agent_kind: parsed.agent_kind,
      include_neutral: parsed.include_neutral,
      include_cost: parsed.include_cost,
    });
    return toTextContent(out);
  };
}
