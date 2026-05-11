import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const WorkflowRunInputShape = {
  name: z.string().min(1).describe('Workflow name from `workflow.list`.'),
  cwd: z.string().optional().describe('Optional cwd override for project resolution.'),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional workflow args map; forwarded to ts-function workflows as ctx.args and template vars as {{args.*}}.'),
  session_id: z
    .string()
    .min(1)
    .optional()
    .describe('Optional Claude Code session id; scopes recall sources that use sessionStart (e.g., dispatch_events).'),
};

export interface WorkflowRunHandlerOpts {
  resolveCwd?: () => string;
}

export function workflowRunHandler(daemon: DaemonClient, opts: WorkflowRunHandlerOpts = {}) {
  return async (input: unknown) => {
    const body = input as { name: string; cwd?: string; session_id?: string; args?: Record<string, unknown> };
    const payload: typeof body = { ...body };
    if (body.cwd === undefined) {
      const resolvedCwd = opts.resolveCwd?.();
      if (resolvedCwd !== undefined) {
        payload.cwd = resolvedCwd;
      }
    }
    return toTextContent(await daemon.workflowRun(payload));
  };
}
