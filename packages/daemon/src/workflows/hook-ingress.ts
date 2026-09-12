import { z } from "zod";

const BOUNDED_ID = z.string().max(128).nullable();
const DELIVERY_TTL_MS = 5 * 60 * 1000;
const DELIVERY_MAX_ENTRIES = 2_048;
const QUALIFIED_CODEX_TRANSCRIPT_FORMAT = "penumbra-codex-rollout-fixture-v1";

export const CodexIngressSchema = z
  .object({
    harness: z.literal("codex"),
    role: z.enum(["maestro", "dispatch", "unknown"]),
    lineage: z.enum(["root", "child", "unknown"]),
    provenance: z.enum(["verified-launch", "verified-session-correlation", "unknown"]),
    is_child: z.boolean(),
    parent_session_id: BOUNDED_ID,
    agent_id: BOUNDED_ID,
    agent_type: BOUNDED_ID,
    source: BOUNDED_ID,
    turn_id: BOUNDED_ID,
    tool_use_id: BOUNDED_ID,
    delivery_id: BOUNDED_ID,
    transcript_format: z.string().max(128).nullish(),
  })
  .strict();

export type CodexIngress = z.infer<typeof CodexIngressSchema>;

const deliveries = new Map<string, number>();
const continuityInFlight = new Set<string>();

export function admitCodexLifecycle(ingress: CodexIngress): boolean {
  return (
    ingress.role === "maestro" &&
    ingress.lineage === "root" &&
    ingress.provenance !== "unknown" &&
    !ingress.is_child &&
    ingress.parent_session_id === null
  );
}

export function snapshotCodexIngress(ingress: CodexIngress): CodexIngress {
  return {
    ...ingress,
    transcript_format: ingress.transcript_format ?? QUALIFIED_CODEX_TRANSCRIPT_FORMAT,
  };
}

function pruneDeliveries(now: number): void {
  for (const [key, expiresAt] of deliveries) {
    if (expiresAt > now) continue;
    deliveries.delete(key);
  }
  while (deliveries.size >= DELIVERY_MAX_ENTRIES) {
    const oldest = deliveries.keys().next().value;
    if (oldest === undefined) break;
    deliveries.delete(oldest);
  }
}

export function acceptCodexDelivery(opts: {
  ingress: CodexIngress;
  sessionId: string | null;
  event: string;
  now: number;
}): boolean {
  const deliveryId = opts.ingress.delivery_id;
  if (deliveryId === null || deliveryId.length === 0) return true;
  pruneDeliveries(opts.now);
  const key = JSON.stringify([opts.ingress.harness, opts.sessionId, opts.event, deliveryId]);
  const expiresAt = deliveries.get(key);
  if (expiresAt !== undefined && expiresAt > opts.now) return false;
  deliveries.delete(key);
  deliveries.set(key, opts.now + DELIVERY_TTL_MS);
  return true;
}

export function claimCodexContinuity(
  ingress: CodexIngress,
  sessionId: string | null,
): { claimed: boolean; key: string | null } {
  if (sessionId === null || sessionId.length === 0) return { claimed: true, key: null };
  const key = JSON.stringify([ingress.harness, sessionId]);
  if (continuityInFlight.has(key)) return { claimed: false, key };
  continuityInFlight.add(key);
  return { claimed: true, key };
}

export function releaseCodexContinuity(key: string): void {
  continuityInFlight.delete(key);
}
