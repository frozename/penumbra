import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

/**
 * Common API-key resolution shared by every openai-compat-style adapter.
 * Mirrors llamactl's `keychain:`/`env:`/`file:` ref convention so users can
 * keep keys out of `agentchat.yaml` in cleartext.
 *
 * Precedence (first non-empty wins): literal `apiKey` → `apiKeyEnv` →
 * `apiKeyKeychain` → `apiKeyFile`. When nothing is provided this returns
 * `''` so anonymous endpoints (a local dev llama-server) keep working.
 */
export interface ApiKeyOpts {
  apiKey?: string;
  apiKeyEnv?: string;
  /** "service/account" — looked up via macOS Keychain. */
  apiKeyKeychain?: string;
  /** Absolute path to a file whose trimmed content is the key. */
  apiKeyFile?: string;
}

export interface ResolveApiKeyEnv {
  hostPlatform?: NodeJS.Platform;
  /** Test seam — replaces the `security` shell-out. */
  runSecurityCli?: (service: string, account: string) => string;
}

export function resolveAdapterApiKey(opts: ApiKeyOpts, env: ResolveApiKeyEnv = {}): string {
  if (opts.apiKey !== undefined && opts.apiKey !== "") return opts.apiKey;

  if (opts.apiKeyEnv) {
    const v = process.env[opts.apiKeyEnv];
    if (v === undefined || v === "") {
      throw new Error(`apiKeyEnv: env var ${opts.apiKeyEnv} is unset or empty`);
    }
    return v;
  }

  if (opts.apiKeyKeychain) {
    const slash = opts.apiKeyKeychain.indexOf("/");
    if (slash <= 0 || slash === opts.apiKeyKeychain.length - 1) {
      throw new Error(
        `apiKeyKeychain: expected '<service>/<account>', got '${opts.apiKeyKeychain}'`,
      );
    }
    const host = env.hostPlatform ?? platform();
    if (host !== "darwin") {
      throw new Error(`apiKeyKeychain: requires macOS; host is '${host}'`);
    }
    const service = opts.apiKeyKeychain.slice(0, slash);
    const account = opts.apiKeyKeychain.slice(slash + 1);
    const run = env.runSecurityCli ?? defaultRunSecurityCli;
    return run(service, account).trim();
  }

  if (opts.apiKeyFile) {
    return readFileSync(opts.apiKeyFile, "utf8").trim();
  }

  return "";
}

function defaultRunSecurityCli(service: string, account: string): string {
  const out = execFileSync(
    "security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return out;
}
