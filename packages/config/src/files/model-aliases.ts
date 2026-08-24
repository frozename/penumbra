import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { isCanonicalProviderValue } from "../provider-format.js";

import { deepFreeze, loaderError } from "./_loader-util.js";
import { existsPath, readUtf8 } from "./node-fs.js";

const ModelAliasSchema = z
  .object({
    aa_creator: z
      .string()
      .min(1)
      .refine(isCanonicalProviderValue, "must be a canonical provider value"),
    aa_slug: z.string().min(1),
    reasoning_level: z.string().min(1).optional(),
  })
  .strict();

// Multiple seats legitimately run the same underlying model, so shared AA pairs
// preserve the correct per-seat priors rather than creating ambiguity.
export const ModelAliasMapSchema = z.record(z.string().min(1), ModelAliasSchema);
export type ModelAliasMap = z.infer<typeof ModelAliasMapSchema>;

export function loadModelAliasMapFromDir(dir: string): ModelAliasMap {
  const filePath = join(resolve(dir), "model-aliases.yaml");

  try {
    // Own duplicate-key rejection here rather than inheriting the YAML library's default.
    const parsed: unknown = existsPath(filePath)
      ? (parseYaml(readUtf8(filePath), { uniqueKeys: true }) ?? {})
      : {};
    return deepFreeze(ModelAliasMapSchema.parse(parsed));
  } catch (error) {
    throw loaderError(filePath, error);
  }
}
