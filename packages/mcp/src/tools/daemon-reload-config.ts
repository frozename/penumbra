import type { DaemonClient } from '../daemon-client.js';

export const DaemonReloadConfigInputShape = {};

export const daemonReloadConfigHandler = (daemon: DaemonClient) => async (_args: Record<string, never>) => {
  const result = await daemon.reloadConfig();
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
};
