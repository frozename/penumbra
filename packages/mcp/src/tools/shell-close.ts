import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

const ShellCloseInputSchema = z.object({
  handoff_id: z.string().min(1),
  session_id: z.string().min(1),
});

export const ShellCloseInputShape = ShellCloseInputSchema.shape;

interface ShellTextResult {
  content: { type: "text"; text: string }[];
}

export function shellCloseHandler(
  daemon: Pick<DaemonClient, "shellClose">,
): (input: unknown) => Promise<ShellTextResult> {
  return async (input): Promise<ShellTextResult> => {
    const parsed = ShellCloseInputSchema.parse(input ?? {});
    const result = await daemon.shellClose(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };
}
