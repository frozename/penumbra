import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import {
  SessionNoteDraftsListResponseSchema,
  SessionNoteDraftsQuerySchema,
} from "@penumbra/api-contract";

import type { DaemonClient } from "../daemon-client.js";

export const SessionNoteDraftsInputSchema = SessionNoteDraftsQuerySchema;
export const SessionNoteDraftsInputShape = SessionNoteDraftsInputSchema.shape;

export function sessionNoteDraftsHandler(
  daemon: Pick<DaemonClient, "sessionNoteDrafts">,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input): Promise<TextContentEnvelope> => {
    const parsed = SessionNoteDraftsInputSchema.parse(input ?? {});
    const response = SessionNoteDraftsListResponseSchema.parse(
      await daemon.sessionNoteDrafts(parsed),
    );
    return toTextContent(response);
  };
}
