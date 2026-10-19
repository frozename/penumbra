import {
  BoundsInputSchema,
  EligibilitySchema,
  ExpectedArtifactSchema,
  TaskKindSchema,
  TaskPrioritySchema,
} from "@penumbra/core";
import { z } from "zod";

export const TriggerSchema = z.discriminatedUnion("kind", [
  // skill names a plugin skill such as penumbra:handoff for generated slash-command delegation.
  z.object({
    kind: z.literal("slash"),
    command: z.string().min(1),
    skill: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("lifecycle"),
    event: z.enum([
      "session-start",
      "session-end",
      "pre-compact",
      "stop",
      "user-prompt-submit",
      "pre-tool-use",
      "post-tool-use",
    ]),
    filter: z
      .object({
        tool_name: z.array(z.string().min(1)).min(1).optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("state-threshold"),
    metric: z.enum([
      "queue-idle-min",
      "time-since-last-handoff-min",
      "pending-handoffs",
      "commits-since-last-handoff",
      "context-window-percent",
      "pending-review-lanes",
    ]),
    op: z.enum([">", "<"]),
    value: z.number(),
    poll_interval_s: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal("manual") }),
]);

const ArgsRecord = z.record(z.string(), z.unknown());

// Any recall source may be marked required: composeRecall reports it in
// RecallBundle.requiredFailures when it throws or yields nothing usable, and
// executeWorkflow then fails the run closed instead of emitting a hollow
// artifact. `skip_if_arg` names an args.* path (dot-separated); composeRecall
// drops the source entirely when it resolves to a non-empty value — for
// inputs that only exist in one mode, like a refs diff under an explicit
// content_path. Skip wins over required: a skipped source cannot fail.
const OptionalSourceFlags = {
  required: z.boolean().optional(),
  skip_if_arg: z.string().min(1).optional(),
};

export const RecallSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("memory_search"), args: ArgsRecord, ...OptionalSourceFlags }),
  z.object({ source: z.literal("memory_timeline"), args: ArgsRecord, ...OptionalSourceFlags }),
  z.object({
    source: z.literal("memory_get_observations"),
    args: ArgsRecord,
    ...OptionalSourceFlags,
  }),
  z.object({ source: z.literal("git.log"), args: ArgsRecord, ...OptionalSourceFlags }),
  z.object({ source: z.literal("git.show"), args: ArgsRecord, ...OptionalSourceFlags }),
  z.object({ source: z.literal("git.diff"), args: ArgsRecord, ...OptionalSourceFlags }),
  z.object({
    source: z.literal("file.contents"),
    args: z.object({
      path: z.string().min(1),
      max_bytes: z.number().int().positive().optional(),
      allowed_roots: z.array(z.string()).optional(),
    }),
    ...OptionalSourceFlags,
  }),
  z.object({
    source: z.literal("latest_continuation_note"),
    args: ArgsRecord.optional(),
    ...OptionalSourceFlags,
  }),
  z.object({
    source: z.literal("pending_handoff"),
    args: ArgsRecord.optional(),
    ...OptionalSourceFlags,
  }),
  z.object({
    source: z.literal("session_first_moves"),
    args: ArgsRecord.optional(),
    ...OptionalSourceFlags,
  }),
  z.object({
    source: z.literal("routing_bias_list"),
    args: ArgsRecord.optional(),
    ...OptionalSourceFlags,
  }),
  z.object({
    source: z.literal("registrar_status"),
    args: ArgsRecord.optional(),
    ...OptionalSourceFlags,
  }),
  z.object({ source: z.literal("dispatch_events"), args: ArgsRecord, ...OptionalSourceFlags }),
  z.object({ source: z.literal("session_events"), args: ArgsRecord, ...OptionalSourceFlags }),
  z.object({
    source: z.literal("handoff_list_pending"),
    args: ArgsRecord.optional(),
    ...OptionalSourceFlags,
  }),
  z.object({ source: z.literal("agents"), args: ArgsRecord.optional(), ...OptionalSourceFlags }),
  z.object({ source: z.literal("fs_glob"), args: ArgsRecord, ...OptionalSourceFlags }),
  z.object({ source: z.literal("fs_grep"), args: ArgsRecord, ...OptionalSourceFlags }),
  z.object({
    source: z.literal("daemon.endpoint"),
    args: z.object({ path: z.string() }),
    ...OptionalSourceFlags,
  }),
]);

export const ProcessGateNameSchema = z.enum([
  "verification-before-complete",
  "tdd",
  "brainstorm-first",
  "worktree-isolation",
]);

export const OutputSinkSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    mode: z.enum(["overwrite", "append", "skip-if-exists", "unique-suffix"]).optional(),
    optional: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("clipboard") }),
  z.object({ kind: z.literal("next-session-prompt"), optional: z.boolean().optional() }),
  z.object({ kind: z.literal("commit"), message: z.string() }),
  z.object({
    kind: z.literal("dispatch"),
    agent: z.string().optional(),
    task_type: z.string().optional(),
  }),
  z.object({ kind: z.literal("session-reminder") }),
  z.object({ kind: z.literal("observation"), optional: z.boolean().optional() }),
  z.object({
    kind: z.literal("task"),
    prompt: z.string().min(1),
    acceptance_criteria: z.string().optional(),
    expected_artifacts: z.array(ExpectedArtifactSchema).optional(),
    eligibility: EligibilitySchema.optional(),
    task_kind: TaskKindSchema.optional(),
    bounds: BoundsInputSchema.optional(),
    review_eligibility: EligibilitySchema.optional(),
    priority: TaskPrioritySchema.optional(),
    requires_review: z.boolean().optional(),
    optional: z.boolean().optional(),
  }),
]);

export const RunBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("markdown-template"), template: z.string() }),
  z.object({ kind: z.literal("ts-function") }),
]);

export const WorkflowSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase kebab-case"),
  description: z.string(),
  triggers: z.array(TriggerSchema).min(1),
  recall: z.array(RecallSourceSchema),
  recall_budget_tokens: z.number().int().positive().optional(),
  process_gates: z.array(ProcessGateNameSchema).optional(),
  output: z.array(OutputSinkSchema),
  run: RunBodySchema,
  capture: z.object({ stats_key: z.string().optional() }).optional(),
});

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type RecallSource = z.infer<typeof RecallSourceSchema>;
export type OutputSink = z.infer<typeof OutputSinkSchema>;
export type ProcessGateName = z.infer<typeof ProcessGateNameSchema>;
