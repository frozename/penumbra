import type { DaemonClient } from '../daemon-client.js';

export const DaemonReloadConfigInputShape = {};
export const DAEMON_RELOAD_CONFIG_DESCRIPTION =
  'Hot-reload the daemon-side agentchat validation registry from agentchat.yaml without restarting the daemon. Worker agentchat config is reloaded separately via the worker control bus — see daemon.reload_workers.';

export const daemonReloadConfigHandler = (daemon: DaemonClient) => async (_args: Record<string, never>) => {
  const result = await daemon.reloadConfig();
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
};
