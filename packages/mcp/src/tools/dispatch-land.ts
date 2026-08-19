import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const DispatchLandInputShape = {
  handoff_id: z
    .string()
    .min(1)
    .describe("The handoff_id whose recorded branch_name should be landed."),
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
    .describe("Delete the handoff branch_name after landing. Default true."),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Bypass verdict_unverified gate manually. Default false. Without force, the gate auto-passes when dispatch_audit is trustworthy and recommends accept.",
    ),
  reject_if_held: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true and the git-write lock is held by another in-flight land, return a structured { ok:false, error:{ code:'lifecycle_busy', holder, retry_after_ms } } immediately instead of queuing. Default false (serialize behind the lock).",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Client-side poll deadline in ms (default 60000). On expiry returns { status: 'still_running', task_id } so the caller can resume-poll via GET /dispatch/land/:taskId instead of re-POSTing.",
    ),
};

interface DispatchLandResult {
  content: { type: "text"; text: string }[];
}

interface DispatchLandInput {
  handoff_id: string;
  commit_message: string;
  mode?: "squash" | "ff";
  delete_branch?: boolean;
  force?: boolean;
  reject_if_held?: boolean;
  timeout_ms?: number;
}

export function dispatchLandHandler(
  daemon: Pick<DaemonClient, "dispatchLand">,
): (input: DispatchLandInput) => Promise<DispatchLandResult> {
  return async (input): Promise<DispatchLandResult> => {
    const out = await daemon.dispatchLand({
      handoff_id: input.handoff_id,
      commit_message: input.commit_message,
      mode: input.mode,
      delete_branch: input.delete_branch,
      force: input.force,
      reject_if_held: input.reject_if_held,
      timeout_ms: input.timeout_ms,
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
