import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { SessionEventsListResponseSchema } from "@penumbra/api-contract";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const SessionEventsRecentInputSchema = z
  .object({
    session_id: z.string().min(1).optional(),
    kind_prefix: z.string().min(1).optional(),
    since: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

export const SessionEventsRecentInputShape = SessionEventsRecentInputSchema.shape;

export function sessionEventsRecentHandler(
  daemon: Pick<DaemonClient, "sessionEventsRecent">,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input): Promise<TextContentEnvelope> => {
    const parsed = SessionEventsRecentInputSchema.parse(input ?? {});
    const response = SessionEventsListResponseSchema.parse(
      await daemon.sessionEventsRecent(parsed),
    );
    return toTextContent(response);
  };
}
