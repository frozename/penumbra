import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

export const DispatchLandInputShape = {
  handoff_id: z.string().min(1).describe("The handoff_id to land from agent/<handoff_id>."),
  commit_message: z.string().min(1).describe("Curated commit message used for squash commits."),
  mode: z
    .enum(["squash", "ff"])
    .optional()
    .default("squash")
    .describe("Landing mode: squash (default) or ff-only."),
  delete_branch: z
    .boolean()
    .optional()
    .default(true)
    .describe("Delete agent/<handoff_id> after landing. Default true."),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Bypass verdict_unverified gate manually. Default false. Without force, the gate auto-passes when dispatch_audit is trustworthy and recommends accept.",
    ),
};

export function dispatchLandHandler(daemon: Pick<DaemonClient, "dispatchLand">) {
  return async (input: {
    handoff_id: string;
    commit_message: string;
    mode?: "squash" | "ff";
    delete_branch?: boolean;
    force?: boolean;
  }) => {
    const out = await daemon.dispatchLand({
      handoff_id: input.handoff_id,
      commit_message: input.commit_message,
      mode: input.mode,
      delete_branch: input.delete_branch,
      force: input.force,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(out, null, 2),
        },
      ],
    };
  };
}
