import { MaestroSessionRecord } from "@penumbra/core";
import { toTextContent } from "@nova/mcp-shared";
import { z } from "zod";
import { DaemonHttpError, type DaemonClient } from "../daemon-client.js";

export const MaestroSessionGetInputSchema = z
  .object({
    task_id: z.string().min(1),
  })
  .strict();
export const MaestroSessionGetInputShape = MaestroSessionGetInputSchema.shape;

export function maestroSessionGetHandler(daemon: Pick<DaemonClient, "maestroSessionGet">) {
  return async (input: unknown) => {
    const parsed = MaestroSessionGetInputSchema.parse(input ?? {});
    try {
      const out = await daemon.maestroSessionGet(parsed.task_id);
      return toTextContent(MaestroSessionRecord.parse(out));
    } catch (err) {
      if (err instanceof DaemonHttpError && err.status === 404) {
        return toTextContent(null);
      }
      throw err;
    }
  };
}
