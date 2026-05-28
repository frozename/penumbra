import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

/**
 * Reverts a dream action. P1 promote_t1: un-promotes t1 rollup and retires minted t2. P2 link: retires memory_links row. P3 retire: un-retires t2 memory. P6 brief: deletes project_briefs row (gated by generated_at <= decided_at). P7 reembed: restores prior embedding vector from t2_vec_history. Other phases (P3 rewrite, P4, P5): stamp reverted_by only (no state change). cascade='none' refuses with 409 has_dependents when other auto_applied actions reference this action via payload_json.source_action_id. cascade='force' recurses topologically (children first).
 */
export const MemoryDreamActionRevertInputShape = z.object({
  action_id: z.string().min(1),
  cascade: z.enum(["none", "force"]).default("none").optional(),
});

export type MemoryDreamActionRevertInput = z.infer<typeof MemoryDreamActionRevertInputShape>;

export function memoryDreamActionRevertHandler(daemon: DaemonClient) {
  return async (args: unknown) => {
    const input = MemoryDreamActionRevertInputShape.parse(args);
    return await daemon.memoryDreamActionRevert(input);
  };
}
