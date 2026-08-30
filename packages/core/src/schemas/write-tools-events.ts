import { z } from "zod";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex64");

export const FsWriteAppliedPayload = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256,
  prev_sha256: Sha256.nullable(),
  handoff_id: z.string(),
});
export type FsWriteAppliedPayload = z.infer<typeof FsWriteAppliedPayload>;

export const FsEditAppliedPayload = z.object({
  path: z.string(),
  bytes_added: z.number().int().nonnegative(),
  bytes_removed: z.number().int().nonnegative(),
  sha256: Sha256,
  prev_sha256: Sha256,
  handoff_id: z.string(),
});
export type FsEditAppliedPayload = z.infer<typeof FsEditAppliedPayload>;

export const TerminalSpawnedPayload = z.object({
  terminal_id: z.string(),
  argv: z.array(z.string()),
  cwd: z.string(),
  env_keys: z.array(z.string()),
  handoff_id: z.string(),
});
export type TerminalSpawnedPayload = z.infer<typeof TerminalSpawnedPayload>;

export const TerminalExitedPayload = z.object({
  terminal_id: z.string(),
  exit_code: z.number().int(),
  signal: z.string().nullable(),
  output_bytes: z.number().int().nonnegative(),
  output_truncated: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  handoff_id: z.string(),
});
export type TerminalExitedPayload = z.infer<typeof TerminalExitedPayload>;

export const TerminalKilledPayload = z.object({
  terminal_id: z.string(),
  // 'idle_ttl' and 'max_lifetime' kept in the enum for forward-compat with Phase 1d.5 even though
  // the in-scope C2 design only emits 'timeout' / 'output_overflow' / 'dispatch_end' / 'operator' / 'cancelled'.
  reason: z.enum([
    "timeout",
    "output_overflow",
    "dispatch_end",
    "idle_ttl",
    "max_lifetime",
    "operator",
    "cancelled",
  ]),
  handoff_id: z.string(),
});
export type TerminalKilledPayload = z.infer<typeof TerminalKilledPayload>;

export const TerminalFailedPayload = z.object({
  method: z.string(),
  code: z.number().int(),
  message: z.string(),
  handoff_id: z.string(),
});
export type TerminalFailedPayload = z.infer<typeof TerminalFailedPayload>;
