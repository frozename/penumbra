import { z } from "zod";

import { VERIFY_COMMAND_ALLOWLIST } from "./verify-command.js";

const TaskClassEnum = z.enum(["BOUNDARY", "STANDARD", "TRIVIAL"]);
const TaskTypeEnum = z.enum([
  "plan_refine",
  "implement_small",
  "implement_substantial",
  "review_adversarial",
  "docs_mechanical",
  "debug_diagnose",
  "smoke_test",
  "health_check",
  "unknown",
]);

const VerifyCommandSchema = z
  .string()
  .min(1)
  .refine((cmd) => VERIFY_COMMAND_ALLOWLIST.has(cmd), {
    message: "unknown verify command",
  });

const VerifyCommandsSchema = z
  .array(VerifyCommandSchema)
  .min(1)
  .refine((cmds) => new Set(cmds).size === cmds.length, {
    message: "duplicate verify commands are not allowed",
  });

const TaskSchema = z
  .object({
    name: z.string().min(1).max(120),
    dispatch_prompt: z.string().min(1).max(100_000),
    verify_checklist: z.string().max(10_000).optional(),
    agent: z.string().min(1).max(120).optional(),
    task_class: TaskClassEnum.optional(),
    task_type: TaskTypeEnum.optional(),
    branch_base: z.string().min(1).max(512).optional(),
    branch_type: z.string().min(1).max(120).optional(),
    isolated_install: z.boolean().optional(),
  })
  .strict();

export const inputSchema = z
  .object({
    tasks: z.array(TaskSchema).min(1).max(16),
    verify_agent: z.string().min(1).max(120).default("executor"),
    verify_commands: VerifyCommandsSchema.default([
      "typecheck",
      "typecheck_ratchet",
      "lint_strict",
    ]),
    project_id: z.string().min(1).max(200).optional(),
    out_dir: z.string().max(4_096).optional(),
    timeout_ms: z.number().int().positive().max(7_200_000).default(1_800_000),
  })
  .strict();

export type Input = z.infer<typeof inputSchema>;
export type TaskInput = z.infer<typeof TaskSchema>;
