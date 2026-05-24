import type { DaemonClient } from '../daemon-client.js';

export const DaemonReloadConfigInputShape = {};
export const DAEMON_RELOAD_CONFIG_DESCRIPTION =
  'Hot-reload daemon-side state without restarting the daemon: agentchat validation registry (from agentchat.yaml), workflow registry (rebuilt from plugin/playbooks and plugin/workflows — picks up edits to playbook.md / workflow.ts files), project registry, and extra worker topology. Returns counts on success and a worker_extras summary with started/restarted/stopped/skipped/errors. Worker agentchat config is reloaded separately via the worker control bus — see daemon.reload_workers.';

export const daemonReloadConfigHandler = (daemon: DaemonClient) => async (_args: Record<string, never>) => {
  const result = await daemon.reloadConfig();
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
};
