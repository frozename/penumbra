import { z } from "zod";
import { toTextContent } from "@nova/mcp-shared";
import { BasisSchema } from "@penumbra/core";
import type { DaemonClient } from "../daemon-client.js";

export const VerifyInputShape = {
  memory_id: z.string().min(1),
  claimed_by: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._:@-]+$/)
    .optional(),
  by: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._:@-]+$/)
    .describe("Deprecated: use claimed_by instead")
    .optional(),
  reason: z.string().min(1).max(500).optional(),
  session_id: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  basis: BasisSchema,
};

const VerifySchema = z.object(VerifyInputShape);

export function verifyHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
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
