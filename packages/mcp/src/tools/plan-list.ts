import { z } from "zod";
import { PlanStatusSchema } from "@penumbra/core";
import { toTextContent } from "@nova/mcp-shared";
import type { DaemonClient } from "../daemon-client.js";

export const PlanListInputShape = {
  status: z.string().optional().describe("Optional plan status filter."),
};

export function planListHandler(daemon: Pick<DaemonClient, "planList">) {
  return async (input: { status?: string }) => {
    if (input.status != null) {
      const parsed = PlanStatusSchema.safeParse(input.status);
      if (!parsed.success) {
        throw new Error(`plan.list invalid status: ${input.status}`);
      }
    }
    return toTextContent(await daemon.planList(input));
  };
}
