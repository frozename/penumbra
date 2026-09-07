import { z } from "zod";

export const RegistrarStatusSchema = z.enum(["draft", "active", "paused", "complete", "abandoned"]);
export type RegistrarStatus = z.infer<typeof RegistrarStatusSchema>;

export const RegistrarPhaseStatusSchema = z.enum([
  "pending",
  "active",
  "blocked",
  "complete",
  "abandoned",
]);
export type RegistrarPhaseStatus = z.infer<typeof RegistrarPhaseStatusSchema>;

export const RegistrarEntryTransitionTargetSchema = z.enum([
  "active",
  "paused",
  "complete",
  "abandoned",
]);
export type RegistrarEntryTransitionTarget = z.infer<typeof RegistrarEntryTransitionTargetSchema>;

export const RegistrarEventKindSchema = z.enum([
  "progress",
  "caveat",
  "blocker",
  "follow_up",
  "decision",
  "phase_transition",
  "link",
  "entry_transition",
]);
export type RegistrarEventKind = z.infer<typeof RegistrarEventKindSchema>;

export const RegistrarActorSchema = z.enum(["maestro", "worker", "sweeper", "operator"]);
export type RegistrarActor = z.infer<typeof RegistrarActorSchema>;

export const RegistrarLinkKindSchema = z.enum([
  "commit_sha",
  "handoff_id",
  "lane_id",
  "workflow_run_id",
  "memory_id",
  "plan_id",
  "gh_issue",
]);
export type RegistrarLinkKind = z.infer<typeof RegistrarLinkKindSchema>;

const RegistrarBodySchema = z
  .string()
  .refine(
    (body) => new TextEncoder().encode(body).byteLength <= 4096,
    "body must be at most 4096 bytes",
  );

const eventBase = {
  phase_no: z.number().int().positive().optional(),
  actor: RegistrarActorSchema,
  body: RegistrarBodySchema,
  link_kind: RegistrarLinkKindSchema.optional(),
  link_value: z.string().min(1).optional(),
};

const RegistrarBlockerStateSchema = z.enum(["opened", "resolved"]);
const RegistrarFollowUpStateSchema = z.enum(["owed", "done", "dropped"]);
const RegistrarEventStateSchema = z
  .union([
    RegistrarBlockerStateSchema,
    RegistrarFollowUpStateSchema,
    RegistrarPhaseStatusSchema,
    RegistrarEntryTransitionTargetSchema,
  ])
  .nullable();

const RegistrarBlockerInputSchema = z
  .object({
    ...eventBase,
    kind: z.literal("blocker"),
    state: RegistrarBlockerStateSchema,
    ref_event_id: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.state === "resolved" && event.ref_event_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ref_event_id"],
        message: "resolved blockers require ref_event_id",
      });
    }
  });

const RegistrarFollowUpInputSchema = z
  .object({
    ...eventBase,
    kind: z.literal("follow_up"),
    state: RegistrarFollowUpStateSchema,
    ref_event_id: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if ((event.state === "done" || event.state === "dropped") && event.ref_event_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ref_event_id"],
        message: `${event.state} follow-ups require ref_event_id`,
      });
    }
  });

export const RegistrarEventInputSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...eventBase, kind: z.literal("progress") }).strict(),
    z.object({ ...eventBase, kind: z.literal("caveat") }).strict(),
    RegistrarBlockerInputSchema,
    RegistrarFollowUpInputSchema,
    z.object({ ...eventBase, kind: z.literal("decision") }).strict(),
    z
      .object({
        ...eventBase,
        phase_no: z.number().int().positive(),
        kind: z.literal("phase_transition"),
        from_status: RegistrarPhaseStatusSchema,
        state: RegistrarPhaseStatusSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("link"),
        link_kind: RegistrarLinkKindSchema,
        link_value: z.string().min(1),
      })
      .strict(),
    z
      .object({
        actor: RegistrarActorSchema,
        body: RegistrarBodySchema,
        kind: z.literal("entry_transition"),
        from_status: RegistrarStatusSchema,
        state: RegistrarEntryTransitionTargetSchema,
        link_kind: RegistrarLinkKindSchema.optional(),
        link_value: z.string().min(1).optional(),
      })
      .strict()
      .superRefine((event, ctx) => {
        if (event.state === event.from_status) {
          ctx.addIssue({
            code: "custom",
            path: ["state"],
            message: "entry_transition requires state !== from_status",
          });
        }
      }),
  ])
  // kind="link" requires both fields at the variant level; every other kind may
  // attach a link only as a complete pair.
  .superRefine((event, ctx) => {
    if ((event.link_kind === undefined) !== (event.link_value === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [event.link_kind === undefined ? "link_kind" : "link_value"],
        message: "link_kind and link_value must be provided together",
      });
    }
  });
export type RegistrarEventInput = z.infer<typeof RegistrarEventInputSchema>;

export const RegistrarRollupSchema = z.object({
  open_blockers: z.number().int().nonnegative(),
  open_follow_ups: z.number().int().nonnegative(),
});
export type RegistrarRollup = z.infer<typeof RegistrarRollupSchema>;

export const RegistrarEntrySchema = z.object({
  registrar_id: z.string(),
  slug: z.string(),
  title: z.string(),
  home_project: z.string(),
  source_doc_path: z.string().nullable(),
  status: RegistrarStatusSchema,
  created_at: z.number().int(),
  updated_at: z.number().int(),
  rollup: RegistrarRollupSchema.optional(),
});
export type RegistrarEntry = z.infer<typeof RegistrarEntrySchema>;

export const RegistrarPhaseSchema = z.object({
  registrar_id: z.string(),
  phase_no: z.number().int().positive(),
  title: z.string(),
  status: RegistrarPhaseStatusSchema,
  updated_at: z.number().int(),
});
export type RegistrarPhase = z.infer<typeof RegistrarPhaseSchema>;

export const RegistrarEventSchema = z
  .object({
    event_id: z.number().int().positive(),
    registrar_id: z.string(),
    phase_no: z.number().int().positive().nullable(),
    kind: RegistrarEventKindSchema,
    state: RegistrarEventStateSchema,
    ref_event_id: z.number().int().positive().nullable(),
    link_kind: RegistrarLinkKindSchema.nullable(),
    link_value: z.string().nullable(),
    actor: RegistrarActorSchema,
    body: RegistrarBodySchema,
    created_at: z.number().int(),
  })
  .superRefine((event, ctx) => {
    const stateMatchesKind =
      (event.kind === "blocker" && (event.state === "opened" || event.state === "resolved")) ||
      (event.kind === "follow_up" &&
        (event.state === "owed" || event.state === "done" || event.state === "dropped")) ||
      (event.kind === "phase_transition" &&
        RegistrarPhaseStatusSchema.safeParse(event.state).success) ||
      (event.kind === "entry_transition" &&
        RegistrarEntryTransitionTargetSchema.safeParse(event.state).success) ||
      (event.kind !== "blocker" &&
        event.kind !== "follow_up" &&
        event.kind !== "phase_transition" &&
        event.kind !== "entry_transition" &&
        event.state === null);
    if (!stateMatchesKind) {
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: `state is invalid for ${event.kind}`,
      });
    }
    if (event.kind === "link" && (event.link_kind === null || event.link_value === null)) {
      ctx.addIssue({
        code: "custom",
        path: [event.link_kind === null ? "link_kind" : "link_value"],
        message: "link events require link_kind and link_value",
      });
    }
    if (
      (event.state === "resolved" || event.state === "done" || event.state === "dropped") &&
      event.ref_event_id === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ref_event_id"],
        message: `${event.state} events require ref_event_id`,
      });
    }
  });
export type RegistrarEvent = z.infer<typeof RegistrarEventSchema>;

export const RegistrarCreateRequestSchema = z
  .object({
    title: z.string().min(1),
    slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
    home_project: z.string().min(1),
    phases: z.array(z.string().min(1)).min(1),
    source_doc_path: z.string().min(1).optional(),
    status: RegistrarStatusSchema.default("active"),
  })
  .strict();
export type RegistrarCreateRequest = z.infer<typeof RegistrarCreateRequestSchema>;

export const RegistrarDetailSchema = z
  .object({
    entry: RegistrarEntrySchema,
    phases: z.array(RegistrarPhaseSchema),
    events: z.array(RegistrarEventSchema),
    rollup: RegistrarRollupSchema,
  })
  .loose();
export type RegistrarDetail = z.infer<typeof RegistrarDetailSchema>;

export const RegistrarListResponseSchema = z
  .object({
    entries: z.array(RegistrarEntrySchema),
  })
  .loose();
export type RegistrarListResponse = z.infer<typeof RegistrarListResponseSchema>;

export const RegistrarEventsListResponseSchema = z
  .object({
    events: z.array(RegistrarEventSchema),
  })
  .loose();
export type RegistrarEventsListResponse = z.infer<typeof RegistrarEventsListResponseSchema>;
