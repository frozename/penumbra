import type { HandoffRow } from "@penumbra/api-contract";

export type ChainSendTargetHandoff = Readonly<
  Pick<HandoffRow, "handoff_id" | "conversation_id" | "status" | "cancel_requested_at">
>;

export function selectChainSendTarget(
  conversationId: string,
  latest: ChainSendTargetHandoff | null | undefined,
  dispatched: readonly ChainSendTargetHandoff[] | undefined,
): string | null {
  if (!conversationId) return null;
  if (!latest?.handoff_id) return null;
  if (latest.conversation_id !== conversationId) return null;
  if (latest.status !== "dispatched") return null;
  if (latest.cancel_requested_at !== null) return null;

  if (dispatched?.length !== 1) return null;
  const active = dispatched[0];
  if (active === undefined) return null;
  if (active.handoff_id !== latest.handoff_id) return null;
  if (active.conversation_id !== latest.conversation_id) return null;
  if (active.status !== "dispatched") return null;
  if (active.cancel_requested_at !== null) return null;

  return active.handoff_id;
}
