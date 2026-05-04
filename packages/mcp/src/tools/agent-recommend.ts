import { toTextContent } from '@nova/mcp-shared';
import { AgentRecommendInputSchema } from '../../../core/src/schemas/agent-recommend.js';
import type { DaemonClient } from '../daemon-client.js';

export { AgentRecommendInputSchema };
export const AgentRecommendInputShape = AgentRecommendInputSchema.shape;

export function agentRecommendHandler(daemon: Pick<DaemonClient, 'agentRecommend'>) {
  return async (input: unknown) => {
    const parsed = AgentRecommendInputSchema.parse(input ?? {});
    const out = await daemon.agentRecommend({
      task_type: parsed.task_type,
      risk_class: parsed.risk_class,
      window_days: parsed.window_days,
    });
    return toTextContent(out);
  };
}
