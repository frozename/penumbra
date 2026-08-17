import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { MaestroSessionRecord } from "@penumbra/core";
import { z } from "zod";

import { type DaemonClient, DaemonHttpError } from "../daemon-client.js";

export const MaestroSessionGetInputSchema = z
  .object({
    task_id: z.string().min(1),
  })
  .strict();
export const MaestroSessionGetInputShape = MaestroSessionGetInputSchema.shape;

export function maestroSessionGetHandler(daemon: Pick<DaemonClient, "maestroSessionGet">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
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
