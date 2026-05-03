import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

const ShellRunInputSchema = z.object({
  handoff_id: z.string().min(1),
  agent_name: z.string().min(1),
  session_id: z.string().min(1).optional(),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  pty: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
  stdin: z.string().optional(),
});

export const ShellRunInputShape = ShellRunInputSchema.shape;

export function shellRunHandler(daemon: Pick<DaemonClient, 'shellRun'>) {
  return async (input: unknown) => {
    const parsed = ShellRunInputSchema.parse(input ?? {});
    const result = await daemon.shellRun(parsed);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  };
}
