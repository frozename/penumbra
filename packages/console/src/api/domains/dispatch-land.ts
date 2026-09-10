import {
  type DispatchLandAccepted,
  DispatchLandAcceptedSchema,
  type DispatchLandRequestInput,
  DispatchLandRequestSchema,
  type DispatchLandTask,
  DispatchLandTaskSchema,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { DaemonContractError } from "../errors.js";
import { fillPath } from "../paths.js";

export const PATHS = {
  land: "/dispatch/land",
  task: "/dispatch/land/:id",
} as const;

export interface DispatchLandSlice {
  land(body: DispatchLandRequestInput): Promise<DispatchLandAccepted>;
  task(taskId: string): Promise<DispatchLandTask>;
}

export function dispatchLandSlice(t: DaemonTransport): DispatchLandSlice {
  return {
    land(body: DispatchLandRequestInput): Promise<DispatchLandAccepted> {
      const parsed = DispatchLandRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.land),
          issues: parsed.error.issues,
          rawBody: body,
        });
      }
      return t.request({
        method: "POST",
        path: fillPath(PATHS.land),
        body,
        schema: DispatchLandAcceptedSchema,
      });
    },
    task(taskId: string): Promise<DispatchLandTask> {
      return t.request({
        path: fillPath(PATHS.task, { id: taskId }),
        schema: DispatchLandTaskSchema,
      });
    },
  };
}
