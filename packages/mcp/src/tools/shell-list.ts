import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

const ShellListInputSchema = z.object({
  handoff_id: z.string().min(1),
});

export const ShellListInputShape = ShellListInputSchema.shape;

interface ShellTextResult {
  content: { type: "text"; text: string }[];
}

export function shellListHandler(
  daemon: Pick<DaemonClient, "shellList">,
): (input: unknown) => Promise<ShellTextResult> {
  return async (input): Promise<ShellTextResult> => {
    const parsed = ShellListInputSchema.parse(input ?? {});
    const result = await daemon.shellList(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };
}
