import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { isCanonicalProviderValue } from "../provider-format.js";
import { deepFreeze, loaderError } from "./_loader-util.js";
import { AgentOptionsSchema, CARRIER_CLI_OPTION_KEYS, CARRIER_TOOL_OPTION_KEYS } from "./agents.js";
import { existsPath, readUtf8 } from "./node-fs.js";

const ProviderValueSchema = z
  .string()
  .min(1)
  .refine(isCanonicalProviderValue, "must be a canonical provider value");

const CLI_BINDING_KINDS = new Set(["cli", "agy-cli"]);

// Reuse the real AgentOptionsSchema validators so carrier ranges cannot drift
// from what the daemon validates on seats.
const CarrierToolOptionsShape = AgentOptionsSchema.pick({
  fsReadTextFile: true,
  fsWriteTextFile: true,
  terminal: true,
  terminal_max_concurrent: true,
  terminal_output_max_bytes: true,
  terminal_path: true,
  terminal_timeout_s: true,
} satisfies Record<(typeof CARRIER_TOOL_OPTION_KEYS)[number], true>).shape;

// Reuse the real AgentOptionsSchema validators so carrier ranges cannot drift
// from what the daemon validates on seats.
const CarrierCliOptionsShape = AgentOptionsSchema.pick({
  pass_via: true,
  strip_patterns: true,
} satisfies Record<(typeof CARRIER_CLI_OPTION_KEYS)[number], true>).shape;

export const ProviderBindingCarriersSchema = z
  .object({
    binary: z.string().min(1).optional(),
    args_template: z.array(z.string().min(1)).min(1).optional(),
    env: z.record(z.string().min(1), z.string()).optional(),
    unset_env: z.array(z.string().min(1)).optional(),
    mcp_servers: z.unknown().optional(),
    authMethodId: z.string().min(1).optional(),
    subscription_model_source: z.enum(["modelId", "displayName"]).optional(),
    ...CarrierToolOptionsShape,
    ...CarrierCliOptionsShape,
  })
  .strict();

export const ProviderBindingSchema = z
  .object({
    kind: z.enum(["cli", "stdio-acp", "opencode-acp", "agy-cli", "openai-compat-http"]),
    pricing_mode: z.enum(["api", "subscription"]),
    api_provider: ProviderValueSchema,
    subscription_provider: ProviderValueSchema.optional(),
    model_carrier: z.string().min(1),
    seat_name_template: z.string().min(1),
    carriers: ProviderBindingCarriersSchema.optional(),
    catalog_authority: z.enum(["provider-catalog", "session-handshake"]).optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.carriers === undefined || CLI_BINDING_KINDS.has(binding.kind)) return;
    for (const key of CARRIER_CLI_OPTION_KEYS) {
      if (binding.carriers[key] === undefined) continue;
      context.addIssue({
        code: "custom",
        path: ["carriers", key],
        message: `carriers.${key} is only supported for binding kind '${binding.kind}'`,
      });
    }
  });
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;

export const ProviderSourceSchema = z
  .object({
    discovery: z
      .object({
        kind: z.string().min(1),
        locator: z.string().min(1),
      })
      .strict(),
    auth: z
      .object({
        keychain: z.string().min(1).optional(),
        oauth_marker: z.string().min(1).optional(),
      })
      .strict(),
    include_models: z.array(z.string().min(1)).min(1).optional(),
    exclude_models: z.array(z.string().min(1)).optional(),
    bindings: z.record(z.string().min(1), ProviderBindingSchema),
  })
  .strict()
  .superRefine((source, context) => {
    for (const [bindingName, binding] of Object.entries(source.bindings)) {
      if (
        binding.catalog_authority === "session-handshake" &&
        source.discovery.kind !== "acp-session"
      ) {
        context.addIssue({
          code: "custom",
          path: ["bindings", bindingName, "catalog_authority"],
          message: "catalog_authority 'session-handshake' requires discovery.kind 'acp-session'",
        });
      }
    }
  });
export type ProviderSource = z.infer<typeof ProviderSourceSchema>;

export const ProviderSourcesConfigSchema = z.record(z.string().min(1), ProviderSourceSchema);
export type ProviderSourcesConfig = z.infer<typeof ProviderSourcesConfigSchema>;

export function resolveCatalogAuthority(
  binding: ProviderBinding,
  source: ProviderSource,
): "provider-catalog" | "session-handshake" {
  return (
    binding.catalog_authority ??
    (source.discovery.kind === "acp-session" ? "session-handshake" : "provider-catalog")
  );
}

export function loadProviderSourcesFromDir(dir: string): ProviderSourcesConfig {
  const filePath = join(resolve(dir), "providers.yaml");

  try {
    const parsed: unknown = existsPath(filePath)
      ? (parseYaml(readUtf8(filePath), { uniqueKeys: true }) ?? {})
      : {};
    return deepFreeze(ProviderSourcesConfigSchema.parse(parsed));
  } catch (error) {
    throw loaderError(filePath, error);
  }
}
