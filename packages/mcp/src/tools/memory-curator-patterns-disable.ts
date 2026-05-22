import { z } from 'zod';
import { toTextContent } from '@nova/mcp-shared';
import type { DaemonClient } from '../daemon-client.js';

export const MemoryCuratorPatternsDisableInputShape = {
  pattern_id: z.string().min(1).describe('The pattern_id to disable'),
};

const Schema = z.object(MemoryCuratorPatternsDisableInputShape);

export function memoryCuratorPatternsDisableHandler(daemon: DaemonClient) {
  return async (input: unknown) => {
    const parsed = Schema.parse(input);
    return toTextContent(await daemon.postCuratorPatternDisable(parsed));
  };
}
