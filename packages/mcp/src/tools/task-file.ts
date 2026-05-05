import { toTextContent } from '@nova/mcp-shared';
import { FileTaskInputSchema } from '@penumbra/core';
import type { DaemonClient } from '../daemon-client.js';
import { resolveToolOrigin } from '../tool-origin.js';

export const TaskFileInputSchema = FileTaskInputSchema;
export const TaskFileInputShape = TaskFileInputSchema.shape;

export function taskFileHandler(daemon: Pick<DaemonClient, 'taskFile'>) {
  return async (input: unknown, extra: unknown) => {
    const parsed = TaskFileInputSchema.parse(input ?? {});
    const origin = resolveToolOrigin(extra);
    const out = await daemon.taskFile(parsed, origin ? { origin } : {});
    return toTextContent(out);
  };
}
