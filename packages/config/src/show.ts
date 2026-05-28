import { ENV_REGISTRY } from "./env.js";
import type { ConfigBundle } from "./load.js";

export interface FormatOptions {
  json?: boolean;
}

function escapeControlChars(value: string): string {
  return value.replace(
    /[\x00-\x1F\x7F]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

export function formatEnvConfig(bundle: ConfigBundle, opts: FormatOptions = {}): string {
  const keys = Object.keys(ENV_REGISTRY).sort();

  if (opts.json) {
    const env: Record<string, unknown> = {};
    const sources: Record<string, "explicit" | "default"> = {};

    for (const key of keys) {
      const entry = ENV_REGISTRY[key]!;
      const value = bundle.env[key];
      // Coerce undefined → null so unset keys appear in JSON output instead of
      // being silently dropped by JSON.stringify (keysets must match between
      // --json and text mode).
      env[key] = entry.isSensitive ? "<redacted>" : (value ?? null);
      sources[key] = bundle.sources[key]!;
    }

    return JSON.stringify({ env, sources }, null, 2);
  }

  return keys
    .map((key) => {
      const entry = ENV_REGISTRY[key]!;
      const source = bundle.sources[key]!;
      const value = bundle.env[key];
      const rendered = entry.isSensitive
        ? "<redacted>"
        : value === undefined
          ? "<unset>"
          : escapeControlChars(String(value));

      return `${key}=${rendered}  # source: ${source}`;
    })
    .join("\n");
}
