import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { PlanStatusSchema } from "@penumbra/core";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const PlanListInputShape = {
  status: z.string().optional().describe("Optional plan status filter."),
};

export function planListHandler(
  daemon: Pick<DaemonClient, "planList">,
): (input: { status?: string }) => Promise<TextContentEnvelope> {
  return async (input): Promise<TextContentEnvelope> => {
    if (input.status !== undefined) {
      const parsed = PlanStatusSchema.safeParse(input.status);
      if (!parsed.success) {
        throw new Error(`plan.list invalid status: ${input.status}`);
      }
    }
    return toTextContent(await daemon.planList(input));
  };
}
