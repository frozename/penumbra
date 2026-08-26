import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { DaemonHttpError } from "../daemon-client.js";

export const RegistrarStatusInputShape = {
  registrar_id: z.string().min(1).describe("The registrar entry ID to query."),
};

const RegistrarStatusInputSchema = z.object(RegistrarStatusInputShape).strict();

export function registrarStatusHandler(daemon: Pick<DaemonClient, "registrarStatus">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const request = RegistrarStatusInputSchema.parse(input);
    try {
      return toTextContent(await daemon.registrarStatus(request));
    } catch (err) {
      if (err instanceof DaemonHttpError && err.status === 404) {
        throw new Error("registrar entry not found");
      }
      throw err;
    }
  };
}
