import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

const BasisSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("lane_close"),
    lane_id: z.string().min(1),
    reviewer_handoff: z.string().min(1),
  }),
  z.object({
    kind: z.literal("dispatch_land"),
    merge_commit: z
      .string()
      .min(7)
      .max(40)
      .regex(/^[a-f0-9]+$/),
    reviewer_handoff: z.string().min(1),
  }),
  z.object({
    kind: z.literal("adversarial_review"),
    synthesis_path: z.string().min(1),
    synthesizer_handoff: z.string().min(1),
  }),
  z.object({
    kind: z.literal("manual_override"),
    reason: z.string().min(1),
    authorized_by: z.string().min(1),
  }),
]);

export const MemoryVerifyAuthorizeInputShape = {
  handoff_id: z.string().min(1),
  verdict: z.enum(["passed", "failed", "skipped", "review_debt"]),
  basis: BasisSchema,
  authorized_by_handoff: z.string().min(1).optional().nullable(),
};

const MemoryVerifyAuthorizeSchema = z.object(MemoryVerifyAuthorizeInputShape).strict();

export function memoryVerifyAuthorizeHandler(daemon: Pick<DaemonClient, "memoryVerifyAuthorize">) {
  return async (input: unknown): Promise<TextContentEnvelope> => {
    const parsed = MemoryVerifyAuthorizeSchema.parse(input);
    return toTextContent(await daemon.memoryVerifyAuthorize(parsed));
  };
}
