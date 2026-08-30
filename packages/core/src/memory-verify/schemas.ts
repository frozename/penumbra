import { z } from "zod";

import { BasisSchema } from "./basis.js";

export const MemoryVerifyAuthorizeInputShape = {
  handoff_id: z.string().min(1),
  verdict: z.enum(["passed", "failed", "skipped", "review_debt"]),
  basis: BasisSchema,
  authorized_by_handoff: z.string().min(1).optional().nullable(),
};

export const MemoryVerifyClaimInputShape = {
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
