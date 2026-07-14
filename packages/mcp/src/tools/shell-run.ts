import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { handoffErrorContent, resolveHandoffId } from "./handoff-guard.js";

const ShellRunInputSchema = z.object({
  handoff_id: z.string().min(1),
  agent_name: z.string().min(1),
  session_id: z.string().min(1).optional(),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  pty: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
  stdin: z.string().optional(),
});

export const ShellRunInputShape = ShellRunInputSchema.shape;

interface ShellTextResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

export function shellRunHandler(
  daemon: Pick<DaemonClient, "shellRun">,
): (input: unknown) => Promise<ShellTextResult> {
  return async (input): Promise<ShellTextResult> => {
    const parsed = ShellRunInputSchema.parse(input ?? {});
    const resolved = resolveHandoffId(parsed.handoff_id);
    if (!resolved.ok) {
      return handoffErrorContent(resolved.error.code, resolved.error.message);
    }
    const result = await daemon.shellRun({ ...parsed, handoff_id: resolved.handoff_id });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };
}
