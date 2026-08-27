import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { MemoryVerifyClaimInputShape } from "@penumbra/core";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

export const VerifyInputShape = MemoryVerifyClaimInputShape;

const VerifySchema = z.object(VerifyInputShape);

export function verifyHandler(
  daemon: DaemonClient,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = VerifySchema.parse(input);
    const claimed_by = parsed.claimed_by ?? parsed.by;
    return toTextContent(
      await daemon.memoryVerify({
        memory_id: parsed.memory_id,
        claimed_by,
        reason: parsed.reason,
        session_id: parsed.session_id,
        basis: parsed.basis,
      }),
    );
  };
}
