import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { QuotasConfigSchema } from "@penumbra/config";
import { expandHome } from "./cookie-file.js";

export interface ResolvedConsoleConfig {
  workspace_id: string;
  base_url: string;
  /** Absolute (or ~-expanded) path to the session-cookie file. */
  cookie_file: string;
}

export interface LoadOpencodeConsoleConfigOptions {
  /** Override the penumbra config dir (testing). */
  configDir?: string;
  /** Override file reads (testing). */
  readFileImpl?: (path: string) => string;
}

/**
 * Resolve the opencode-console reader config from the centralized quotas.yaml
 * (`providers[name=opencode-go].opencode_console`). Returns null when the file,
 * provider, or block is absent — the worker then simply omits the reader.
 * A relative cookie_file is resolved against the config dir; `~` is expanded.
 */
export function loadOpencodeConsoleConfig(
  opts: LoadOpencodeConsoleConfigOptions = {},
): ResolvedConsoleConfig | null {
  const configDir =
    opts.configDir ?? process.env.PENUMBRA_CONFIG_DIR ?? join(homedir(), ".config", "penumbra");
  const quotasPath = join(configDir, "quotas.yaml");
  const read = opts.readFileImpl ?? ((p: string) => readFileSync(p, "utf8"));

  let raw: string;
  try {
    raw = read(quotasPath);
  } catch {
    return null;
  }

  let parsed: ReturnType<typeof QuotasConfigSchema.parse>;
  try {
    parsed = QuotasConfigSchema.parse(parseYaml(raw));
  } catch {
    return null;
  }

  const consoleCfg = parsed.providers.find((p) => p.name === "opencode-go")?.opencode_console;
  if (!consoleCfg) return null;

  const cf = consoleCfg.cookie_file;
  const cookie_file = cf.startsWith("~")
    ? expandHome(cf)
    : isAbsolute(cf)
      ? cf
      : join(configDir, cf);

  return {
    workspace_id: consoleCfg.workspace_id,
    base_url: consoleCfg.base_url,
    cookie_file,
  };
}
