import { z } from "zod";

export const PermissionStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const PermissionRememberSchema = z.enum(["this_call", "this_dispatch"]);
export type PermissionRemember = z.infer<typeof PermissionRememberSchema>;

export const PermissionRequestRowSchema = z.object({
  permission_id: z.string(),
  parent_handoff_id: z.string(),
  conversation_id: z.string(),
  agent_name: z.string(),
  tool_name: z.string(),
  raw_input_json: z.string(),
  status: PermissionStatusSchema,
  remember_scope: PermissionRememberSchema.nullable(),
  decision_reason: z.string().nullable(),
  decided_by: z.string().nullable(),
  ttl_at: z.string(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type PermissionRequestRow = z.infer<typeof PermissionRequestRowSchema>;

export const CreatePermissionRequestSchema = z.object({
  permission_id: z.string().min(1),
  parent_handoff_id: z.string().min(1),
  conversation_id: z.string().min(1),
  agent_name: z.string().min(1),
  tool_name: z.string().min(1),
  raw_input: z.unknown(),
  ttl_seconds: z.number().int().positive().optional(),
});
export type CreatePermissionRequest = z.infer<typeof CreatePermissionRequestSchema>;

export const ApprovePermissionRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  remember: PermissionRememberSchema.optional(),
  reason: z.string().optional(),
  resolved_by: z.string().min(1).optional(),
});
export type ApprovePermissionRequest = z.infer<typeof ApprovePermissionRequestSchema>;
