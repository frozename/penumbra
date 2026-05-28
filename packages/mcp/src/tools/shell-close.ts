import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

const ShellCloseInputSchema = z.object({
  handoff_id: z.string().min(1),
  session_id: z.string().min(1),
});

export const ShellCloseInputShape = ShellCloseInputSchema.shape;

export function shellCloseHandler(daemon: Pick<DaemonClient, "shellClose">) {
  return async (input: unknown) => {
    const parsed = ShellCloseInputSchema.parse(input ?? {});
    const result = await daemon.shellClose(parsed);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };
}
