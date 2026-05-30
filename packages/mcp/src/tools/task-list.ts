import { toTextContent } from "@nova/mcp-shared";
import { TaskKindSchema, TaskStatusSchema } from "@penumbra/core";
import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import { makeEnvelopeResult } from "../responses/envelope.js";
import { estimateTokens, truncateToTokens, DEFAULT_BUDGET } from "../responses/budget.js";

export const TaskListInputSchema = z
  .object({
    status: TaskStatusSchema.optional(),
    kind: TaskKindSchema.optional(),
    eligible_for: z.string().min(1).optional(),
    parent_task_id: z.string().min(1).optional(),
    origin: z.string().min(1).optional(),
    limit: z.number().int().positive().max(500).optional(),
    offset: z.number().int().nonnegative().optional(),
    envelope: z
      .boolean()
      .optional()
      .describe(
        "When true, return a token-budgeted envelope with _meta.token_budget + result_bytes instead of the raw payload.",
      ),
  })
  .strict();
export const TaskListInputShape = TaskListInputSchema.shape;

export function taskListHandler(daemon: Pick<DaemonClient, "taskList">) {
  return async (input: unknown) => {
    const parsed = TaskListInputSchema.parse(input ?? {});
    const { envelope, ...rest } = parsed;
    const out = await daemon.taskList(rest);
    if (envelope) {
      const rawJson = JSON.stringify(out, null, 2);
      const resultBytes = Buffer.byteLength(rawJson, "utf8");
      const { text, truncated } = truncateToTokens(rawJson, DEFAULT_BUDGET);
      return makeEnvelopeResult([{ type: "text", text }], {
        usedTokens: estimateTokens(text),
        limitTokens: DEFAULT_BUDGET,
        truncated,
        resultBytes,
      });
    }
    return toTextContent(out);
  };
}
