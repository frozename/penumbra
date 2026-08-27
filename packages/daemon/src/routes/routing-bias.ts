import { isCanonicalProviderValue } from "@penumbra/config";
import {
  clearRoutingBias,
  readRoutingBiases,
  RoutingBiasClearInputSchema,
  type RoutingBias,
  type Services,
  setRoutingBias,
} from "@penumbra/core";
import { z } from "zod";

import { bodyJson, json } from "./_helpers.js";

const SetInputSchema = z
  .object({
    scope: z.enum(["provider", "agent"]),
    value: z.string().min(1),
    mode: z.enum(["boost", "divert", "exclude"]),
    weight: z.number().min(0).max(2.0).optional(),
    ttl_seconds: z.number().int().positive().optional(),
    expires_at: z.iso.datetime().optional(),
    reason: z.string().optional(),
  })
  .refine((data) => data.ttl_seconds !== undefined || data.expires_at !== undefined, {
    message: "Set requires either ttl_seconds or expires_at",
  })
  // Provider-scope bias values are matched with strict `===` against an agent's
  // resolved provider (always canonical, enforced at config load). Reject a
  // non-canonical value here rather than storing a bias that would silently
  // never match — fail closed at the write boundary. See @penumbra/core
  // provider-format. Agent-scope values are agent names, left unconstrained.
  .refine((data) => data.scope !== "provider" || isCanonicalProviderValue(data.value), {
    path: ["value"],
    message: 'provider bias value must be canonical lowercase-hyphen (e.g. "openai", "sakana")',
  });

const ListInputSchema = z.object({
  scope: z.enum(["provider", "agent"]).optional(),
  value: z.string().min(1).optional(),
});

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)}d`);
  if (hours % 24 > 0) parts.push(`${String(hours % 24)}h`);
  if (minutes % 60 > 0) parts.push(`${String(minutes % 60)}m`);
  if (seconds % 60 > 0 || parts.length === 0) parts.push(`${String(seconds % 60)}s`);

  return parts.join(" ");
}

function enrichWithTimeRemaining(
  bias: RoutingBias,
  now: Date,
): RoutingBias & { time_remaining: string } {
  const expiresAt = new Date(bias.expires_at);
  const remainingMs = expiresAt.getTime() - now.getTime();
  return {
    ...bias,
    time_remaining: formatTimeRemaining(remainingMs),
  };
}

export async function routingBiasSetRoute(req: Request, services: Services): Promise<Response> {
  const body = await bodyJson(req);
  const parsed = SetInputSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }
  try {
    const result = setRoutingBias(services.db, {
      ...parsed.data,
      now: services.clock(),
    });
    return json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: { code: "invalid_params", message } }, 400);
  }
}

export function routingBiasListRoute(req: Request, services: Services): Response {
  const url = new URL(req.url);
  const parsed = ListInputSchema.safeParse({
    scope: url.searchParams.get("scope") ?? undefined,
    value: url.searchParams.get("value") ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }
  const now = services.clock();
  const biases = readRoutingBiases(services.db, {
    now,
    scope: parsed.data.scope,
    value: parsed.data.value,
  });
  return json({
    biases: biases.map((b) => enrichWithTimeRemaining(b, now)),
  });
}

export async function routingBiasClearRoute(req: Request, services: Services): Promise<Response> {
  const body = await bodyJson(req);
  const parsed = RoutingBiasClearInputSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }
  try {
    const result = clearRoutingBias(services.db, {
      bias_id: parsed.data.bias_id,
      scope: parsed.data.scope,
      value: parsed.data.value,
      all: parsed.data.all,
    });
    return json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: { code: "invalid_params", message } }, 400);
  }
}
