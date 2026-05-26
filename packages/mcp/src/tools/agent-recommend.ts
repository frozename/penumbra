import { toTextContent } from '@nova/mcp-shared';
import { z } from 'zod';
// @ts-ignore TS6059/TS6307: temporary cross-package source import until config exports WORKLOADS at package root.
import { WORKLOADS } from '../../../config/src/files/workload.js';
import type { DaemonClient } from '../daemon-client.js';

type Workload = (typeof WORKLOADS)[number];
type AgentRecommendDeprecationLogger = { info: (message: string) => void };
const taskTypeDeprecationLogged = new Set<AgentRecommendDeprecationLogger>();

export function resetAgentRecommendTaskTypeDeprecationForTests(): void {
  taskTypeDeprecationLogged.clear();
}

export const AgentRecommendInputSchema = z.object({
  task_type: z.enum(WORKLOADS).optional(),
  workload: z.enum(WORKLOADS).optional(),
  risk_class: z.string().min(1).optional(),
  window_days: z.coerce.number().int().positive().optional(),
  agent_kind: z.enum(['coding', 'long_lived']).optional(),
}).superRefine((value, ctx) => {
  if (value.task_type === undefined && value.workload === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workload'],
      message: "Either 'workload' or 'task_type' is required",
    });
  }
});

export const AgentRecommendInputShape = AgentRecommendInputSchema.shape;

export function agentRecommendHandler(
  daemon: Pick<DaemonClient, 'agentRecommend'>,
  opts: { logger?: AgentRecommendDeprecationLogger } = {},
) {
  return async (input: unknown) => {
    const parsed = AgentRecommendInputSchema.parse(input ?? {});
    const logger = opts.logger ?? console;
    const workload = parsed.workload as Workload | undefined;
    const taskType = parsed.task_type as Workload | undefined;
    if (workload !== undefined && taskType !== undefined && workload !== taskType) {
      throw new Error(
        `agent_recommend: workload='${workload}' conflicts with task_type='${taskType}'; pass only one or matching values`,
      );
    }
    const resolvedTaskType = workload ?? taskType;
    if (workload === undefined && taskType !== undefined && !taskTypeDeprecationLogged.has(logger)) {
      logger.info("agent_recommend: task_type is deprecated; prefer 'workload' instead");
      taskTypeDeprecationLogged.add(logger);
    }
    const body: Parameters<DaemonClient['agentRecommend']>[0] = {
      task_type: resolvedTaskType,
      risk_class: parsed.risk_class,
      window_days: parsed.window_days,
      agent_kind: parsed.agent_kind,
    };
    if (workload !== undefined) body.workload = workload;
    const out = await daemon.agentRecommend(body);
    return toTextContent(out);
  };
}
