import type { ConfigBundle } from "./load.js";

import { ENV_REGISTRY } from "./env.js";

export interface FormatOptions {
  json?: boolean;
}

function escapeControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += char;
    }
  }
  return out;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "<unset>";
  if (typeof value === "string") return escapeControlChars(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

export function formatEnvConfig(bundle: ConfigBundle, opts: FormatOptions = {}): string {
  const keys = Object.keys(ENV_REGISTRY).sort();

  if (opts.json) {
    const env: Record<string, unknown> = {};
    const sources: Record<string, "explicit" | "default"> = {};

    for (const key of keys) {
      const entry = ENV_REGISTRY[key];
      if (!entry) continue;
      const value = bundle.env[key];
      // Coerce undefined → null so unset keys appear in JSON output instead of
      // being silently dropped by JSON.stringify (keysets must match between
      // --json and text mode).
      env[key] = entry.isSensitive ? "<redacted>" : (value ?? null);
      sources[key] = bundle.sources[key] ?? "default";
    }

    return JSON.stringify({ env, sources }, null, 2);
  }

  return keys
    .map((key) => {
      const entry = ENV_REGISTRY[key];
      if (!entry) return null;
      const source = bundle.sources[key] ?? "default";
      const value = bundle.env[key];
      const rendered = entry.isSensitive
        ? "<redacted>"
        : value === undefined
          ? "<unset>"
          : renderValue(value);

      return `${key}=${rendered}  # source: ${source}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}
