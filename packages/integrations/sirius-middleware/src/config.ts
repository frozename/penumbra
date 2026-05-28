import { hostname } from "node:os";

export type MiddlewareConfig =
  | { kind: "enabled"; baseUrl: string; token: string; machineId: string }
  | { kind: "disabled"; reason: string };

export function loadConfig(): MiddlewareConfig {
  const rawUrl = process.env.PENUMBRA_DAEMON_URL;
  const rawToken = process.env.PENUMBRA_DAEMON_TOKEN;

  if (!rawUrl) {
    return { kind: "disabled", reason: "PENUMBRA_DAEMON_URL is not set" };
  }
  if (!rawToken) {
    return { kind: "disabled", reason: "PENUMBRA_DAEMON_TOKEN is not set" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "disabled", reason: `PENUMBRA_DAEMON_URL is not a valid URL: ${rawUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "disabled",
      reason: `PENUMBRA_DAEMON_URL must be http or https (got ${parsed.protocol})`,
    };
  }

  const baseUrl = rawUrl.replace(/\/$/, "");
  const machineId = hostname() || "unknown-host";
  return { kind: "enabled", baseUrl, token: rawToken, machineId };
}
