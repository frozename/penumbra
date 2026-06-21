import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const ApproveHandoffInputShape = {
  handoff_id: z.string(),
  redirect_to: z.string().optional(),
  reject: z.boolean().optional(),
  reason: z.string().optional(),
};

interface ApproveHandoffResult {
  content: { type: "text"; text: string }[];
}

interface ApproveHandoffInput {
  handoff_id: string;
  redirect_to?: string;
  reject?: boolean;
  reason?: string;
}

export function approveHandoffHandler(
  daemon: DaemonClient,
): (input: ApproveHandoffInput) => Promise<ApproveHandoffResult> {
  return async (input): Promise<ApproveHandoffResult> => {
    const body: { redirect_to?: string; reject?: boolean; reason?: string } = {};
    if (input.redirect_to) body.redirect_to = input.redirect_to;
    if (input.reject) body.reject = input.reject;
    if (input.reason) body.reason = input.reason;
    const r = await daemon.approveHandoff(input.handoff_id, body);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(r) }],
    };
  };
}
