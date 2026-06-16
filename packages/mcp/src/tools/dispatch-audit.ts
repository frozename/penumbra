import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

export const DispatchAuditInputShape = {
  handoff_id: z
    .string()
    .min(1)
    .describe("The handoff_id whose reliability audit report should be returned."),
};

export function dispatchAuditHandler(daemon: Pick<DaemonClient, "dispatchAudit">) {
  return async (input: { handoff_id: string }) => {
    const audit = await daemon.dispatchAudit(input.handoff_id);
    const rawJson = JSON.stringify(audit, null, 2);
    return {
      content: [
        {
          type: "text" as const,
          text: rawJson,
        },
      ],
    };
  };
}
