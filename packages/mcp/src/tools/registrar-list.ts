import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

const RegistrarListInputSchema = z.object({}).strict();

export const RegistrarListInputShape = RegistrarListInputSchema.shape;

export function registrarListHandler(daemon: Pick<DaemonClient, "registrarList">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    RegistrarListInputSchema.parse(input ?? {});
    return toTextContent(await daemon.registrarList());
  };
}
