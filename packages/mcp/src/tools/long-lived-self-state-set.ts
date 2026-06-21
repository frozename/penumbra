import type { Database } from "bun:sqlite";

import { updateLongLivedAgentState } from "@penumbra/core/long-lived/self-reader";
import { WorkingMemorySchema } from "@penumbra/core/long-lived/types";
import { z } from "zod";

import { verifyRunningIdentity } from "../long-lived-context.js";

const SelfStateSetArgsBaseSchema = z.object({
  intent_summary: z.string().optional(),
  working_memory: WorkingMemorySchema.optional(),
});

export const SelfStateSetInputShape = SelfStateSetArgsBaseSchema.shape;
export const SelfStateSetArgsSchema = SelfStateSetArgsBaseSchema.refine(
  (a) => a.intent_summary !== undefined || a.working_memory !== undefined,
  { message: "at least one of intent_summary or working_memory required" },
);

export interface SelfStateSetContext {
  running_agent_id?: string;
  running_tick_id?: string;
}

export function handleLongLivedSelfStateSet(
  db: Database,
  ctx: SelfStateSetContext,
  args: unknown,
): { ok: true } {
  const identity = verifyRunningIdentity(db, ctx);
  const parsed = SelfStateSetArgsSchema.parse(args);
  (updateLongLivedAgentState as unknown as (db: Database, ...args: unknown[]) => void)(
    db,
    identity.agent_id,
    parsed,
    { running_tick_id: identity.tick_id },
  );
  return { ok: true };
}
