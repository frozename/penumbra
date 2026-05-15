import type { DaemonClient } from '../daemon-client.js';
import { chainStartHandler, ChainStartInputShape, type ChainStartHandlerOpts } from './chain-start.js';

export { ChainStartInputShape as ChainStartRefinedInputShape };

export function chainStartRefinedHandler(daemon: DaemonClient, opts: ChainStartHandlerOpts = {}) {
  const inner = chainStartHandler(daemon, opts);
  return async (input: { message: string; [k: string]: unknown }) => {
    const { refined } = await daemon.dispatchRefine(input.message);
    return inner({ ...input, message: refined });
  };
}
