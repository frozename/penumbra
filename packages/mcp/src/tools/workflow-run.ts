import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const WorkflowRunInputShape = {
  name: z.string().min(1).describe("Workflow name from `workflow.list`."),
  cwd: z.string().optional().describe("Optional cwd override for project resolution."),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional workflow args map; forwarded to ts-function workflows as ctx.args and template vars as {{args.*}}.",
    ),
  session_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Claude Code session id; scopes recall sources that use sessionStart (e.g., dispatch_events).",
    ),
  wait: z
    .boolean()
    .optional()
    .describe("When true, wait for the workflow to finish and return the full result body."),
};

const WorkflowRunSchema = z.object(WorkflowRunInputShape).strict();

export interface WorkflowRunHandlerOpts {
  /**
   * Optional fallback for resolving `cwd` when the caller omits it. NOTE: the
   * default in registry.ts points at `process.cwd()` (the MCP-subprocess cwd),
   * which is the daemon's WorkingDirectory — typically NOT the caller's repo.
   * Workflows invoked without an explicit `cwd` from a cross-repo session will
   * silently resolve to the daemon's project. Mirror of the chain_start
   * cwd-fallback trap.
   */
  resolveCwd?: () => string;
}

export class WorkflowCwdRequiredError extends Error {
  readonly code = "workflow_cwd_required";
  readonly hint =
    "Pass an explicit `cwd` for cross-repo workflow runs. The MCP-subprocess cwd is the daemon, not your repo. PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID is set.";

  constructor(message = "workflow_cwd_required") {
    super(message);
    this.name = "WorkflowCwdRequiredError";
  }
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function workflowRunHandler(daemon: DaemonClient, opts: WorkflowRunHandlerOpts = {}) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = WorkflowRunSchema.parse(input);
    const payload = { ...parsed };
    let resolutionWarning: string | undefined;
    if (parsed.cwd === undefined) {
      if (isEnvTruthy(process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID)) {
        throw new WorkflowCwdRequiredError();
      }
      const resolvedCwd = opts.resolveCwd?.();
      if (resolvedCwd !== undefined) {
        payload.cwd = resolvedCwd;
        resolutionWarning = "workflow_cwd_inferred_from_mcp_cwd";
      }
    }
    const result = await daemon.workflowRun(payload);
    if (resolutionWarning !== undefined) {
      return toTextContent({
        ...(result as Record<string, unknown>),
        resolution_warning: resolutionWarning,
      });
    }
    return toTextContent(result);
  };
}
