import {
  type ApprovePermissionRequest,
  ApprovePermissionRequestSchema,
  type PermissionDecideResponse,
  PermissionDecideResponseSchema,
  type PermissionGetResponse,
  PermissionGetResponseSchema,
  type PermissionRequestRow,
  type PermissionsListResponse,
  PermissionsListResponseSchema,
  type PermissionStatus,
} from "@penumbra/api-contract";

import type { DaemonTransport } from "../transport.js";

import { DaemonContractError } from "../errors.js";
import { fillPath } from "../paths.js";

const PermissionDecideBodySchema = ApprovePermissionRequestSchema.omit({
  resolved_by: true,
}).strict();

export const PATHS = {
  list: "/permissions",
  get: "/permissions/:id",
  decide: "/permissions/:id/decide",
} as const;

export interface PermissionsSlice {
  list(query?: { status?: PermissionStatus }): Promise<PermissionsListResponse>;
  get(id: string): Promise<PermissionRequestRow>;
  decide(
    id: string,
    body: Omit<ApprovePermissionRequest, "resolved_by">,
  ): Promise<PermissionDecideResponse>;
}

export function permissionsSlice(t: DaemonTransport): PermissionsSlice {
  return {
    list(query?: { status?: PermissionStatus }): Promise<PermissionsListResponse> {
      return t.request({
        path: fillPath(PATHS.list),
        query: { status: query?.status },
        schema: PermissionsListResponseSchema,
      });
    },
    get(id: string): Promise<PermissionRequestRow> {
      return t
        .request({
          path: fillPath(PATHS.get, { id }),
          schema: PermissionGetResponseSchema,
        })
        .then((res: PermissionGetResponse): PermissionRequestRow => res.permission);
    },
    async decide(
      id: string,
      body: Omit<ApprovePermissionRequest, "resolved_by">,
    ): Promise<PermissionDecideResponse> {
      const parsed = PermissionDecideBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new DaemonContractError({
          url: fillPath(PATHS.decide, { id }),
          issues: parsed.error.issues,
          rawBody: body,
        });
      }
      return await t.request({
        method: "POST",
        path: fillPath(PATHS.decide, { id }),
        body: parsed.data,
        schema: PermissionDecideResponseSchema,
      });
    },
  };
}
