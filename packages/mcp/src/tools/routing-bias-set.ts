import { type TextContentEnvelope, toTextContent } from "@novaproto/mcp-shared";
import { isCanonicalProviderValue } from "@penumbra/config";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

const RoutingBiasSetInputObject = z.object({
  scope: z.enum(["provider", "agent"]),
  value: z.string().min(1),
  mode: z.enum(["boost", "divert", "exclude"]),
  weight: z.number().min(0).max(2.0).optional(),
  ttl_seconds: z.number().int().positive().optional(),
  expires_at: z.iso.datetime().optional(),
  reason: z.string().optional(),
});

export const RoutingBiasSetInputSchema = RoutingBiasSetInputObject.refine(
  (data) => data.ttl_seconds !== undefined || data.expires_at !== undefined,
  {
    message: "Either ttl_seconds or expires_at must be provided",
    path: ["ttl_seconds"],
  },
)
  // Reject a non-canonical provider-scope value at the MCP edge, mirroring the
  // daemon route + config-load guards, so it fails with a clean schema error
  // before the daemon round-trip rather than 400-ing there. Agent-scope values
  // are agent names and stay unconstrained. See @penumbra/config provider-format.
  .refine((data) => data.scope !== "provider" || isCanonicalProviderValue(data.value), {
    message: 'provider bias value must be canonical lowercase-hyphen (e.g. "openai", "nvidia-nim")',
    path: ["value"],
  });

// Shape comes from the base object (refines do not expose `.shape`).
export const RoutingBiasSetInputShape = RoutingBiasSetInputObject.shape;

export type RoutingBiasSetInput = z.infer<typeof RoutingBiasSetInputSchema>;

export function routingBiasSetHandler(
  daemon: DaemonClient,
): (input: unknown) => Promise<TextContentEnvelope> {
  return async (input): Promise<TextContentEnvelope> => {
    const parsed = RoutingBiasSetInputSchema.parse(input);
    const out = await daemon.routingBiasSet(parsed);
    return toTextContent(out);
  };
}
