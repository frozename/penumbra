import { z } from "zod";

const TaskSchema = z
  .object({
    message: z.string().trim().min(1),
    task_name: z.string().trim().min(1).max(120).optional(),
    branch_type: z.string().trim().min(1).optional(),
    task_class: z.enum(["BOUNDARY", "STANDARD", "TRIVIAL"]).optional(),
    task_type: z
      .enum([
        "plan_refine",
        "implement_small",
        "implement_substantial",
        "review_adversarial",
        "docs_mechanical",
        "debug_diagnose",
        "smoke_test",
        "health_check",
        "unknown",
      ])
      .optional(),
  })
  .strict();

const RubricSchema = z
  .array(z.string().trim().min(1).max(500))
  .min(1)
  .max(20)
  .superRefine((criteria, refinement) => {
    const seen = new Set<string>();
    for (const [index, criterion] of criteria.entries()) {
      const normalized = criterion
        .toLowerCase()
        .replace(/^\s*\d+\s*[.):-]\s*/, "")
        .replaceAll(/\s+/g, " ")
        .replace(/\.$/, "")
        .trim();
      if (seen.has(normalized)) {
        refinement.addIssue({
          code: "custom",
          path: [index],
          message: "rubric criteria must be unique after normalization",
        });
      }
      seen.add(normalized);
    }
  });

export const inputSchema = z
  .object({
    task: TaskSchema,
    check: z.string().trim().min(1),
    allow_partial_check: z.boolean().default(false),
    agent: z.string().min(1).default("executor"),
    escalate_to: z.string().min(1).optional(),
    max_rounds: z.number().int().min(1).max(10).default(3),
    base: z.string().min(1).default("main"),
    isolated_install: z.boolean().optional(),
    project_id: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    caller_cwd: z.string().min(1).optional(),
    out_dir: z.string().optional(),
    timeout_ms: z.number().int().positive().default(1_800_000),
    verify_check: z.boolean().default(true),
    verifier_agent: z.string().min(1).optional(),
    parity_check: z.string().trim().min(1).optional(),
    rubric: RubricSchema.optional(),
    grader_agent: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, refinement) => {
    if (!value.verify_check && value.parity_check !== undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["parity_check"],
        message:
          "parity_check requires verify_check; the independent verifier runs the parity command",
      });
    }
  });

export type FixUntilGreenInput = z.infer<typeof inputSchema>;
