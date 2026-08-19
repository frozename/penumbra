import { type ChainStartResponse, ChainStartResponseSchema } from "@penumbra/api-contract";
import { WORKLOADS } from "@penumbra/config";
import { ChainStartRequestSchema, TaskClassSchema } from "@penumbra/core";
import { z } from "zod";

import type { DaemonClient } from "../daemon-client.js";

import { formatChainStart, wrapWithSummary } from "../format-summary.js";

type ChainStartDaemonBody = Parameters<DaemonClient["startChain"]>[0] & {
  task_class?: z.input<typeof TaskClassSchema>;
  workflow_run_id?: string;
};
type Workload = (typeof WORKLOADS)[number];
type DispatchKind = NonNullable<z.infer<typeof ChainStartRequestSchema>["dispatch_kind"]>;
const DISPATCH_KIND_SET = {
  long_lived_tick: true,
  workflow: true,
  thought_analyzer: true,
  orchestrate: true,
} satisfies Record<DispatchKind, true>;
const DISPATCH_KIND_VALUES = Object.keys(DISPATCH_KIND_SET) as [DispatchKind, ...DispatchKind[]];
type ChainStartDeprecationLogger = { info: (message: string) => void };
const taskTypeDeprecationLogged = new Set<ChainStartDeprecationLogger>();

export function resetChainStartTaskTypeDeprecationForTests(): void {
  taskTypeDeprecationLogged.clear();
}

export function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export const ChainStartInputShape = {
  initial_agent: z.string().min(1).describe("The agent to receive the first hop of the chain"),
  message: z.string().min(1).describe("The user message that kicks off the chain"),
  task_name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional short human-readable task name for the worktree branch slug"),
  branch_type: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,19}$/)
    .refine((value) => value !== "agent", {
      message: "branch_type 'agent' is reserved for legacy handoff branches",
    })
    .optional()
    .describe("Optional branch type prefix such as feat, fix, docs, review, plan, chore, or task"),
  conversation_id: z
    .string()
    .min(1)
    .optional()
    .describe("Optional caller-supplied conversation id"),
  project_id: z.string().min(1).nullable().optional().describe("Optional project scope"),
  max_hops: z.number().int().positive().optional().describe("Maximum hop count (default 8)"),
  trust_mode: z
    .enum(["all", "config"])
    .optional()
    .describe("all = auto-approve every edge; config = consult auto_approve_to"),
  use_worktree: z
    .boolean()
    .optional()
    .describe("Whether to spawn the worker in an isolated git worktree (default true)"),
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
    .optional()
    .describe(
      "DEPRECATED: optional task type hint for agent performance routing. Prefer 'workload'; if both are provided they must match and workload takes precedence.",
    ),
  workload: z.enum(WORKLOADS).optional().describe("Optional alias for task_type"),
  parent_handoff_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional handoff ID this dispatch is spawned from. Used by ACP agents calling chain.start during their turn so penumbra can enforce a recursion depth cap. Omit for user-initiated dispatches.",
    ),
  dispatch_kind: z
    .enum(DISPATCH_KIND_VALUES)
    .optional()
    .describe("Optional dispatch classification for internal dispatches."),
  workflow_run_id: z
    .string()
    .min(1)
    .optional()
    .describe("Server-issued workflow run token required for workflow dispatch exemptions."),
  long_lived_agent_id: z
    .string()
    .min(1)
    .optional()
    .describe("Optional long-lived agent identity for long-lived ticks."),
  long_lived_tick_id: z
    .string()
    .min(1)
    .optional()
    .describe("Optional long-lived tick identity for long-lived ticks."),
  branch_base: z
    .string()
    .min(1)
    .optional()
    .describe("Optional git ref to use as the initial worktree base"),
  open_pr_on_review: z
    .boolean()
    .optional()
    .describe("Optional opt-in to open a GitHub PR after successful reconcile. Default false."),
  isolated_install: z
    .boolean()
    .optional()
    .describe(
      "Optional opt-in to run bun install in the dispatch worktree instead of mirroring node_modules symlinks.",
    ),
  task_class: TaskClassSchema.describe("Required task class for dispatch routing"),
  caller_cwd: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("/"), {
      message: "caller_cwd must be an absolute path",
    })
    .optional()
    .describe(
      "Optional absolute path the caller is working from; used to scope the dispatch via projects.yaml parent-walk when project_id is not provided",
    ),
};

export interface ChainStartHandlerOpts {
  /**
   * Called when the caller omits `project_id`. Should return the registered
   * project_id for the current MCP-server cwd, or undefined if cwd is not registered.
   */
  resolveProjectIdFromCwd?: () => string | undefined;
  /**
   * Called when the caller provides `caller_cwd` but not `project_id`.
   * Should parent-walk the given path against the project registry.
   */
  resolveProjectIdFromPath?: (path: string) => string | undefined;
  logger?: ChainStartDeprecationLogger;
}

export class RegistryUnavailableError extends Error {
  readonly code = "registry_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "RegistryUnavailableError";
  }
}

export class ProjectIdRequiredError extends Error {
  readonly code = "project_id_required";
  readonly resolvedProjectId: string;
  readonly hint: string;

  constructor(resolvedProjectId: string) {
    super(`project_id_required: resolved from MCP cwd as ${resolvedProjectId}`);
    this.name = "ProjectIdRequiredError";
    this.resolvedProjectId = resolvedProjectId;
    this.hint =
      "pass project_id explicitly, or unset PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy default";
  }
}

export class CallerCwdNotRegisteredError extends Error {
  readonly code = "caller_cwd_not_registered";
  readonly callerCwd: string;
  readonly hint: string;

  constructor(callerCwd: string) {
    super(
      `caller_cwd_not_registered: ${callerCwd} does not match any entry in the project registry`,
    );
    this.name = "CallerCwdNotRegisteredError";
    this.callerCwd = callerCwd;
    this.hint = "pass project_id explicitly or register the path as a project";
  }
}

interface ChainStartInput {
  initial_agent: string;
  message: string;
  task_name?: string;
  branch_type?: string;
  conversation_id?: string;
  project_id?: string | null;
  max_hops?: number;
  trust_mode?: "all" | "config";
  use_worktree?: boolean;
  task_type?: Workload;
  workload?: Workload;
  parent_handoff_id?: string;
  dispatch_kind?: DispatchKind;
  workflow_run_id?: string;
  long_lived_agent_id?: string;
  long_lived_tick_id?: string;
  branch_base?: string;
  open_pr_on_review?: boolean;
  isolated_install?: boolean;
  task_class?: z.input<typeof TaskClassSchema>;
  caller_cwd?: string;
}

export interface ResolutionWarning {
  code: string;
  resolved_project_id: string;
  caller_cwd?: string;
}

export interface ChainStartResult {
  content: { type: string; text: string }[];
  resolution_warning?: ResolutionWarning;
  routing_warning?: unknown;
  routing_advisory?: unknown;
}

function resolveTaskType(
  input: ChainStartInput,
  logger: ChainStartDeprecationLogger,
): Workload | undefined {
  const workload = input.workload;
  const taskType = input.task_type;
  if (workload !== undefined && taskType !== undefined && workload !== taskType) {
    throw new Error(
      `chain_start: workload='${workload}' conflicts with task_type='${taskType}'; pass only one or matching values`,
    );
  }
  if (workload === undefined && taskType !== undefined && !taskTypeDeprecationLogged.has(logger)) {
    logger.info("chain_start: task_type is deprecated; prefer 'workload' instead");
    taskTypeDeprecationLogged.add(logger);
  }
  return workload ?? taskType;
}

function resolveProjectFromCallerCwd(
  callerCwd: string,
  resolveProjectIdFromPath: ((path: string) => string | undefined) | undefined,
): { projectId: string; warning: ResolutionWarning } {
  if (!resolveProjectIdFromPath) {
    throw new Error("caller_cwd_not_supported: resolveProjectIdFromPath callback not configured");
  }
  const resolvedFromPath = resolveProjectIdFromPath(callerCwd);
  if (resolvedFromPath === undefined) {
    throw new CallerCwdNotRegisteredError(callerCwd);
  }
  return {
    projectId: resolvedFromPath,
    warning: {
      code: "project_id_resolved_from_caller_cwd",
      resolved_project_id: resolvedFromPath,
      caller_cwd: callerCwd,
    },
  };
}

function isInternalHop(input: ChainStartInput): boolean {
  const isLongLivedTickHop =
    input.dispatch_kind === "long_lived_tick" &&
    typeof input.long_lived_tick_id === "string" &&
    input.long_lived_tick_id.length > 0 &&
    typeof input.long_lived_agent_id === "string" &&
    input.long_lived_agent_id.length > 0;
  const isWorkflowHop =
    input.dispatch_kind === "workflow" &&
    typeof input.workflow_run_id === "string" &&
    input.workflow_run_id.length > 0;
  return isLongLivedTickHop || isWorkflowHop;
}

function resolveProjectFromCwd(
  effectiveProjectId: string | null | undefined,
  input: ChainStartInput,
  opts: ChainStartHandlerOpts,
): { projectId: string | null | undefined; warning: ResolutionWarning | undefined } {
  const resolveProjectIdFromCwd = opts.resolveProjectIdFromCwd;
  const requireExplicitProjectId = isEnvTruthy(process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID);
  const shouldResolveProjectFromCwd =
    effectiveProjectId === undefined &&
    input.use_worktree !== false &&
    resolveProjectIdFromCwd !== undefined;
  const shouldRequireExplicitProjectId =
    requireExplicitProjectId &&
    (effectiveProjectId === undefined || effectiveProjectId === null) &&
    resolveProjectIdFromCwd !== undefined;

  if (isInternalHop(input) || !(shouldResolveProjectFromCwd || shouldRequireExplicitProjectId)) {
    return { projectId: effectiveProjectId, warning: undefined };
  }

  let resolved: string | undefined;
  try {
    resolved = resolveProjectIdFromCwd();
  } catch (err) {
    if (err instanceof RegistryUnavailableError) {
      throw new Error(`registry_unavailable: ${err.message}`);
    }
    throw err;
  }
  if (resolved === undefined) {
    throw new Error(
      "cwd_not_registered: MCP server cwd does not match any entry in the project registry; " +
        "pass project_id explicitly or register the cwd as a project",
    );
  }
  if (requireExplicitProjectId) {
    throw new ProjectIdRequiredError(resolved);
  }
  if (effectiveProjectId === undefined) {
    return {
      projectId: resolved,
      warning: { code: "project_id_inferred_from_mcp_cwd", resolved_project_id: resolved },
    };
  }
  return { projectId: effectiveProjectId, warning: undefined };
}

const OPTIONAL_BODY_FIELDS = [
  "conversation_id",
  "task_name",
  "branch_type",
  "max_hops",
  "trust_mode",
  "use_worktree",
  "parent_handoff_id",
  "dispatch_kind",
  "workflow_run_id",
  "long_lived_agent_id",
  "long_lived_tick_id",
  "branch_base",
  "open_pr_on_review",
  "isolated_install",
  "task_class",
] as const satisfies readonly (keyof ChainStartInput)[];

function buildDaemonBody(
  input: ChainStartInput,
  effectiveProjectId: string | null | undefined,
  resolvedTaskType: Workload | undefined,
): ChainStartDaemonBody {
  const body: ChainStartDaemonBody = {
    initial_agent: input.initial_agent,
    message: input.message,
  };
  if (effectiveProjectId !== undefined && effectiveProjectId !== null) {
    body.project_id = effectiveProjectId;
  }
  if (resolvedTaskType !== undefined) {
    body.task_type = resolvedTaskType;
  }
  for (const field of OPTIONAL_BODY_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      (body as Record<string, unknown>)[field] = value;
    }
  }
  return body;
}

export function chainStartHandler(
  daemon: DaemonClient,
  opts: ChainStartHandlerOpts = {},
): (input: ChainStartInput) => Promise<ChainStartResult> {
  return async (input): Promise<ChainStartResult> => {
    const logger = opts.logger ?? console;
    const resolvedTaskType = resolveTaskType(input, logger);

    let effectiveProjectId: string | null | undefined = input.project_id;
    let resolutionWarning: ResolutionWarning | undefined;

    if (
      (effectiveProjectId === undefined || effectiveProjectId === null) &&
      input.caller_cwd !== undefined
    ) {
      const { projectId, warning } = resolveProjectFromCallerCwd(
        input.caller_cwd,
        opts.resolveProjectIdFromPath,
      );
      effectiveProjectId = projectId;
      resolutionWarning = warning;
    }

    const cwdResolution = resolveProjectFromCwd(effectiveProjectId, input, opts);
    effectiveProjectId = cwdResolution.projectId;
    if (cwdResolution.warning !== undefined) {
      resolutionWarning = cwdResolution.warning;
    }

    const body = buildDaemonBody(input, effectiveProjectId, resolvedTaskType);
    const res: ChainStartResponse = ChainStartResponseSchema.parse(await daemon.startChain(body));
    const response: ChainStartResult = {
      content: [
        {
          type: "text",
          text: wrapWithSummary(
            formatChainStart({
              ...res,
              agent: input.initial_agent,
              trust_mode: input.trust_mode,
            }),
            res,
          ),
        },
      ],
    };
    if (resolutionWarning !== undefined) {
      response.resolution_warning = resolutionWarning;
    }
    if (res.routing_warning !== undefined) {
      response.routing_warning = res.routing_warning;
    }
    if (res.routing_advisory !== undefined) {
      response.routing_advisory = res.routing_advisory;
    }
    return response;
  };
}
