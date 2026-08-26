import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { isCanonicalProviderValue } from "../provider-format.js";

import { deepFreeze, loaderError } from "./_loader-util.js";
import { existsPath, readUtf8 } from "./node-fs.js";

const ProviderValueSchema = z
  .string()
  .min(1)
  .refine(isCanonicalProviderValue, "must be a canonical provider value");

export const ProviderBindingSchema = z
  .object({
    kind: z.enum(["cli", "stdio-acp", "opencode-acp", "agy-cli", "openai-compat-http"]),
    pricing_mode: z.enum(["api", "subscription"]),
    api_provider: ProviderValueSchema,
    subscription_provider: ProviderValueSchema.optional(),
    model_carrier: z.string().min(1),
    seat_name_template: z.string().min(1),
  })
  .strict();
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
    exclude_models: z.array(z.string().min(1)).optional(),
    bindings: z.record(z.string().min(1), ProviderBindingSchema),
  })
  .strict();
export type ProviderSource = z.infer<typeof ProviderSourceSchema>;

export const ProviderSourcesConfigSchema = z.record(z.string().min(1), ProviderSourceSchema);
export type ProviderSourcesConfig = z.infer<typeof ProviderSourcesConfigSchema>;

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
