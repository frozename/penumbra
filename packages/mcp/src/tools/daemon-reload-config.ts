import type { DaemonClient } from "../daemon-client.js";

export const DaemonReloadConfigInputShape = {};
export const DAEMON_RELOAD_CONFIG_DESCRIPTION =
  "Hot-reload daemon-side state without restarting the daemon: agentchat validation registry (from agentchat.yaml), workflow registry (rebuilt from plugin/playbooks and plugin/workflows — picks up edits to playbook.md / workflow.ts files), project registry, and extra worker topology. Returns counts on success and a worker_extras summary with started/restarted/stopped/skipped/errors. Worker agentchat config is automatically reloaded via the worker control bus. Also returns provider_quotas: [{provider, max_in_flight, in_flight}] for each provider-wide in-flight cap in effect after the reload.";

interface DaemonReloadConfigResult {
  content: { type: "text"; text: string }[];
}

export const daemonReloadConfigHandler =
  (daemon: DaemonClient): ((_args: Record<string, never>) => Promise<DaemonReloadConfigResult>) =>
  async (_args): Promise<DaemonReloadConfigResult> => {
    const result = await daemon.reloadConfig();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  };
