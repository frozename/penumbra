import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';
import { DaemonHttpError } from '../daemon-client.js';

export const PermissionGetInputShape = {
  permission_id: z.string().min(1).describe('The permission_id to fetch.'),
};

export const permissionGetHandler = (daemon: DaemonClient) => async (args: { permission_id: string }) => {
  try {
    const { permission } = await daemon.getPermission(args.permission_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ permission }, null, 2) }] };
  } catch (err) {
    const status = err instanceof DaemonHttpError ? err.status : (err as any)?.status;
    if (status === 404) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: { code: 'not_found', message: `permission ${args.permission_id} not found` } }, null, 2),
        }],
      };
    }
    throw err;
  }
};
