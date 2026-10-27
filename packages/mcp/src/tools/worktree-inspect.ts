import { z } from "zod";

import { type DaemonClient, DaemonHttpError } from "../daemon-client.js";
import { type ToolHandler, type ToolResult } from "./context.js";
import { handoffErrorContent, resolveHandoffId } from "./handoff-guard.js";

export const WorktreeInspectInputShape = {
  handoff_id: z.string().min(1).describe("The handoff ID to inspect the worktree for"),
};

const InspectionErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// #263: the cheap fields the daemon attaches to an inspection deadline error.
// They are unverified (verified is always false). A partial that does not match
// is dropped and unknown keys are stripped, so no unvalidated field is returned.
const InspectionPartialSchema = z.object({
  head_sha: z.string(),
  branch_name: z.string(),
  dirty: z.boolean(),
  base_ref: z.string().optional(),
  verified: z.literal(false),
});

const InspectionPartialBodySchema = z.object({
  error: z.object({ partial: InspectionPartialSchema }),
});

type InspectionError = {
  code: string;
  message: string;
  partial?: z.infer<typeof InspectionPartialSchema>;
};

function inspectionError(err: DaemonHttpError): InspectionError {
  if (err.status === 404) {
    return { code: "not_found", message: err.message };
  }
  const body = InspectionErrorBodySchema.safeParse(err.body);
  if (!body.success) {
    return { code: "unknown", message: err.message };
  }
  const partial = InspectionPartialBodySchema.safeParse(err.body);
  return partial.success
    ? { ...body.data.error, partial: partial.data.error.partial }
    : body.data.error;
}

export function worktreeInspectHandler(daemon: DaemonClient): ToolHandler<{ handoff_id: string }> {
  return async (input): Promise<ToolResult> => {
    const resolved = resolveHandoffId(input.handoff_id);
    if (!resolved.ok) {
      return handoffErrorContent(resolved.error.code, resolved.error.message);
    }
    try {
      const res = await daemon.inspectWorktree(resolved.handoff_id);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    } catch (err) {
      if (err instanceof DaemonHttpError) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: inspectionError(err) }) }],
          isError: true,
        };
      }
      throw err;
    }
  };
}
