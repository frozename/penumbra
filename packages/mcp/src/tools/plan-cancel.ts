import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { DaemonHttpError } from "../daemon-client.js";

export const PlanCancelInputShape = {
  plan_id: z.string().min(1).describe("The ID of the plan to cancel."),
};

export function planCancelHandler(
  daemon: Pick<DaemonClient, "planCancel">,
): (input: { plan_id: string }) => Promise<TextContentEnvelope> {
  return async (input): Promise<TextContentEnvelope> => {
    try {
      return toTextContent(await daemon.planCancel(input));
    } catch (err) {
      if (isPlanNotFound(err)) {
        throw new Error(`plan.cancel plan not found: ${input.plan_id}`);
      }
      throw err;
    }
  };
}

function isPlanNotFound(err: unknown): err is DaemonHttpError {
  return err instanceof DaemonHttpError && err.status === 404;
}
