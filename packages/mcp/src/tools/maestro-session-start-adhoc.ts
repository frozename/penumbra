import { MaestroSessionRecord } from "@penumbra/core";
import { toTextContent } from "@nova/mcp-shared";
import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

export const MaestroSessionStartAdhocInputSchema = z
  .object({
    message: z.string().min(1),
    agent_id: z.string().min(1),
    wall_clock_budget_ms: z.number().int().positive(),
    cost_budget_cents: z.number().int().positive(),
    sub_dispatch_budget: z.number().int().positive(),
    project_id: z.string().min(1).nullable().optional(),
  })
  .strict();

export const MaestroSessionStartAdhocInputShape = MaestroSessionStartAdhocInputSchema.shape;

const MaestroSessionStartAdhocOutputSchema = z
  .object({
    status: z.literal("dispatched"),
    agent_name: z.string().min(1),
    chain_handoff_id: z.string().min(1),
    conversation_id: z.string().min(1),
    session: MaestroSessionRecord,
  })
  .strict();

export function maestroSessionStartAdhocHandler(
  daemon: Pick<DaemonClient, "maestroSessionStartAdhoc">,
) {
  return async (input: unknown) => {
    const parsed = MaestroSessionStartAdhocInputSchema.parse(input ?? {});
    const out = await daemon.maestroSessionStartAdhoc(parsed);
    return toTextContent(MaestroSessionStartAdhocOutputSchema.parse(out));
  };
}
