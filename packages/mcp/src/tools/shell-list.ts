import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { handoffErrorContent, resolveHandoffId } from "./handoff-guard.js";

const ShellListInputSchema = z.object({
  handoff_id: z.string().min(1),
});

export const ShellListInputShape = ShellListInputSchema.shape;

interface ShellTextResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

export function shellListHandler(
  daemon: Pick<DaemonClient, "shellList">,
): (input: unknown) => Promise<ShellTextResult> {
  return async (input): Promise<ShellTextResult> => {
    const parsed = ShellListInputSchema.parse(input ?? {});
    const resolved = resolveHandoffId(parsed.handoff_id);
    if (!resolved.ok) {
      return handoffErrorContent(resolved.error.code, resolved.error.message);
    }
    const result = await daemon.shellList({ handoff_id: resolved.handoff_id });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };
}
