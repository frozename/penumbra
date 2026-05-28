import { z } from "zod";

export const ErrorEnvelopeSchema = z
  .object({
    error: z.union([
      z
        .object({
          code: z.string(),
          message: z.string().optional(),
        })
        .loose(),
      z.string(),
    ]),
  })
  .loose();

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
