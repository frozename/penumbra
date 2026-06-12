import { z } from "zod";
import { ChainStartRequestSchema, TaskClassSchema } from "@penumbra/core";
import { ChainStartResponseSchema, type ChainStartResponse } from "@penumbra/api-contract";
import { WORKLOADS } from "@penumbra/config";
import type { DaemonClient } from "../daemon-client.js";

type ChainStartDaemonBody = Parameters<DaemonClient["startChain"]>[0] & {
  task_class?: z.input<typeof TaskClassSchema>;
  workflow_run_id?: string;
};
type Workload = (typeof WORKLOADS)[number];
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
    .enum(["long_lived_tick", "workflow"])
    .optional()
    .describe("Optional dispatch classification for long-lived ticks or workflow dispatches."),
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

import { formatChainStart, wrapWithSummary } from "../format-summary.js";

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

export function chainStartHandler(daemon: DaemonClient, opts: ChainStartHandlerOpts = {}) {
  return async (input: any) => {
    const logger = opts.logger ?? console;
    const workload = input.workload as Workload | undefined;
    const taskType = input.task_type as Workload | undefined;
    if (workload !== undefined && taskType !== undefined && workload !== taskType) {
      throw new Error(
        `chain_start: workload='${workload}' conflicts with task_type='${taskType}'; pass only one or matching values`,
      );
    }
    const resolvedTaskType = workload ?? taskType;
    if (
      workload === undefined &&
      taskType !== undefined &&
      !taskTypeDeprecationLogged.has(logger)
    ) {
      logger.info("chain_start: task_type is deprecated; prefer 'workload' instead");
      taskTypeDeprecationLogged.add(logger);
    }
    let effectiveProjectId: string | null | undefined = input.project_id;
    const resolveProjectIdFromCwd = opts.resolveProjectIdFromCwd;
    const resolveProjectIdFromPath = opts.resolveProjectIdFromPath;
    let resolutionWarning:
      | { code: string; resolved_project_id: string; caller_cwd?: string }
      | undefined;

    // caller_cwd resolution: when project_id is omitted but caller_cwd is provided,
    // parent-walk the path against the project registry. Don't fall through to daemon-cwd.
    if (effectiveProjectId == null && input.caller_cwd !== undefined) {
      if (!resolveProjectIdFromPath) {
        throw new Error(
          "caller_cwd_not_supported: resolveProjectIdFromPath callback not configured",
        );
      }
      const resolvedFromPath = resolveProjectIdFromPath(input.caller_cwd);
      if (resolvedFromPath === undefined) {
        throw new CallerCwdNotRegisteredError(input.caller_cwd);
      }
      effectiveProjectId = resolvedFromPath;
      resolutionWarning = {
        code: "project_id_resolved_from_caller_cwd",
        resolved_project_id: resolvedFromPath,
        caller_cwd: input.caller_cwd,
      };
    }

    const requireExplicitProjectId = isEnvTruthy(process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID);
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
    const isInternalHop = isLongLivedTickHop || isWorkflowHop;
    const shouldResolveProjectFromCwd =
      effectiveProjectId === undefined &&
      input.use_worktree !== false &&
      resolveProjectIdFromCwd !== undefined;
    const shouldRequireExplicitProjectId =
      requireExplicitProjectId &&
      (effectiveProjectId === undefined || effectiveProjectId === null) &&
      resolveProjectIdFromCwd !== undefined;

    if (!isInternalHop && (shouldResolveProjectFromCwd || shouldRequireExplicitProjectId)) {
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
        effectiveProjectId = resolved;
        resolutionWarning = {
          code: "project_id_inferred_from_mcp_cwd",
          resolved_project_id: resolved,
        };
      }
    }

    const body: ChainStartDaemonBody = {
      initial_agent: input.initial_agent,
      message: input.message,
    };
    if (input.conversation_id !== undefined) body.conversation_id = input.conversation_id;
    if (effectiveProjectId !== undefined && effectiveProjectId !== null)
      body.project_id = effectiveProjectId;
    if (input.max_hops !== undefined) body.max_hops = input.max_hops;
    if (input.trust_mode !== undefined) body.trust_mode = input.trust_mode;
    if (input.use_worktree !== undefined) body.use_worktree = input.use_worktree;
    if (resolvedTaskType !== undefined) body.task_type = resolvedTaskType;
    if (input.parent_handoff_id !== undefined) body.parent_handoff_id = input.parent_handoff_id;
    if (input.dispatch_kind !== undefined) body.dispatch_kind = input.dispatch_kind;
    if (input.workflow_run_id !== undefined) body.workflow_run_id = input.workflow_run_id;
    if (input.long_lived_agent_id !== undefined)
      body.long_lived_agent_id = input.long_lived_agent_id;
    if (input.long_lived_tick_id !== undefined) body.long_lived_tick_id = input.long_lived_tick_id;
    if (input.branch_base !== undefined) body.branch_base = input.branch_base;
    if (input.open_pr_on_review !== undefined) body.open_pr_on_review = input.open_pr_on_review;
    if (input.isolated_install !== undefined) body.isolated_install = input.isolated_install;
    if (input.task_class !== undefined) body.task_class = input.task_class;
    const res: ChainStartResponse = ChainStartResponseSchema.parse(await daemon.startChain(body));
    const response = {
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
    return {
      ...response,
      ...(resolutionWarning !== undefined ? { resolution_warning: resolutionWarning } : {}),
      ...(res.routing_warning !== undefined ? { routing_warning: res.routing_warning } : {}),
      ...(res.routing_advisory !== undefined ? { routing_advisory: res.routing_advisory } : {}),
    };
  };
}
