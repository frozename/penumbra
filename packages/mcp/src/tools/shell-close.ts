import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { handoffErrorContent, resolveHandoffId } from "./handoff-guard.js";

const ShellCloseInputSchema = z.object({
  handoff_id: z.string().min(1),
  session_id: z.string().min(1),
});

export const ShellCloseInputShape = ShellCloseInputSchema.shape;

interface ShellTextResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

export function shellCloseHandler(
  daemon: Pick<DaemonClient, "shellClose">,
): (input: unknown) => Promise<ShellTextResult> {
  return async (input): Promise<ShellTextResult> => {
    const parsed = ShellCloseInputSchema.parse(input ?? {});
    const resolved = resolveHandoffId(parsed.handoff_id);
    if (!resolved.ok) {
      return handoffErrorContent(resolved.error.code, resolved.error.message);
    }
    const result = await daemon.shellClose({ ...parsed, handoff_id: resolved.handoff_id });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };
}
