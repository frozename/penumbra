import { z } from 'zod';
import { TaskClassSchema } from '@penumbra/core';
import type { DispatchRoutingGuardResult } from '../../../core/src/services/dispatch-routing-guard.js';
import type { DaemonClient } from '../daemon-client.js';

export function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export const ChainStartInputShape = {
  initial_agent: z.string().min(1).describe('The agent to receive the first hop of the chain'),
  message: z.string().min(1).describe('The user message that kicks off the chain'),
  conversation_id: z.string().min(1).optional().describe('Optional caller-supplied conversation id'),
  project_id: z.string().min(1).nullable().optional().describe('Optional project scope'),
  max_hops: z.number().int().positive().optional().describe('Maximum hop count (default 8)'),
  trust_mode: z.enum(['all', 'config']).optional().describe('all = auto-approve every edge; config = consult auto_approve_to'),
  use_worktree: z.boolean().optional().describe('Whether to spawn the worker in an isolated git worktree (default true)'),
  task_type: z.enum([
    'plan_refine',
    'implement_small',
    'implement_substantial',
    'review_adversarial',
    'docs_mechanical',
    'debug_diagnose',
    'smoke_test',
    'health_check',
    'unknown',
  ]).optional().describe('Optional task type hint for agent performance routing'),
  parent_handoff_id: z.string().min(1).optional().describe(
    'Optional handoff ID this dispatch is spawned from. Used by ACP agents calling chain.start during their turn so penumbra can enforce a recursion depth cap. Omit for user-initiated dispatches.'
  ),
  dispatch_kind: z.enum(['long_lived_tick']).optional().describe('Optional dispatch classification for long-lived ticks.'),
  long_lived_agent_id: z.string().min(1).optional().describe('Optional long-lived agent identity for long-lived ticks.'),
  long_lived_tick_id: z.string().min(1).optional().describe('Optional long-lived tick identity for long-lived ticks.'),
  branch_base: z.string().min(1).optional().describe('Optional git ref to use as the initial worktree base'),
  open_pr_on_review: z.boolean().optional().describe('Optional opt-in to open a GitHub PR after successful reconcile. Default false.'),
  task_class: TaskClassSchema.describe('Required task class for dispatch routing'),
  caller_cwd: z.string().min(1).refine((value) => value.startsWith('/'), {
    message: 'caller_cwd must be an absolute path',
  }).optional().describe('Optional absolute path the caller is working from; used to scope the dispatch via projects.yaml parent-walk when project_id is not provided'),
};

import { formatChainStart, wrapWithSummary } from '../format-summary.js';

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
  inspectPromptVsProject?: (input: { prompt: string; project_id: string }) => DispatchRoutingGuardResult;
}

export class RegistryUnavailableError extends Error {
  readonly code = 'registry_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'RegistryUnavailableError';
  }
}

export class ProjectIdRequiredError extends Error {
  readonly code = 'project_id_required';
  readonly resolvedProjectId: string;
  readonly hint: string;

  constructor(resolvedProjectId: string) {
    super(`project_id_required: resolved from MCP cwd as ${resolvedProjectId}`);
    this.name = 'ProjectIdRequiredError';
    this.resolvedProjectId = resolvedProjectId;
    this.hint = 'pass project_id explicitly, or unset PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy default';
  }
}

export class CallerCwdNotRegisteredError extends Error {
  readonly code = 'caller_cwd_not_registered';
  readonly callerCwd: string;
  readonly hint: string;

  constructor(callerCwd: string) {
    super(`caller_cwd_not_registered: ${callerCwd} does not match any entry in the project registry`);
    this.name = 'CallerCwdNotRegisteredError';
    this.callerCwd = callerCwd;
    this.hint = 'pass project_id explicitly or register the path as a project';
  }
}

export class PromptProjectMismatchError extends Error {
  readonly code = 'prompt_project_mismatch';
  readonly projectId: string;
  readonly mentionedPaths: string[];
  readonly missingInProject: string[];
  readonly suggestedProjectId?: string;
  readonly hint: string;

  constructor(input: {
    projectId: string;
    mentionedPaths: string[];
    missingInProject: string[];
    suggestedProjectId?: string;
  }) {
    super(`prompt_project_mismatch: prompt references paths outside project ${input.projectId}`);
    this.name = 'PromptProjectMismatchError';
    this.projectId = input.projectId;
    this.mentionedPaths = input.mentionedPaths;
    this.missingInProject = input.missingInProject;
    this.suggestedProjectId = input.suggestedProjectId;
    this.hint = 'pass --project_id explicitly or update prompt paths';
  }
}

export function chainStartHandler(daemon: DaemonClient, opts: ChainStartHandlerOpts = {}) {
  return async (input: any) => {
    let effectiveProjectId: string | null | undefined = input.project_id;
    const resolveProjectIdFromCwd = opts.resolveProjectIdFromCwd;
    const resolveProjectIdFromPath = opts.resolveProjectIdFromPath;
    let resolutionWarning: { code: string; resolved_project_id: string; caller_cwd?: string } | undefined;

    // caller_cwd resolution: when project_id is omitted but caller_cwd is provided,
    // parent-walk the path against the project registry. Don't fall through to daemon-cwd.
    if (effectiveProjectId == null && input.caller_cwd !== undefined) {
      if (!resolveProjectIdFromPath) {
        throw new Error('caller_cwd_not_supported: resolveProjectIdFromPath callback not configured');
      }
      const resolvedFromPath = resolveProjectIdFromPath(input.caller_cwd);
      if (resolvedFromPath === undefined) {
        throw new CallerCwdNotRegisteredError(input.caller_cwd);
      }
      effectiveProjectId = resolvedFromPath;
      resolutionWarning = {
        code: 'project_id_resolved_from_caller_cwd',
        resolved_project_id: resolvedFromPath,
        caller_cwd: input.caller_cwd,
      };
    }

    const requireExplicitProjectId = isEnvTruthy(process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID);
    const shouldResolveProjectFromCwd =
      effectiveProjectId === undefined &&
      input.use_worktree !== false &&
      resolveProjectIdFromCwd !== undefined;
    const shouldRequireExplicitProjectId = requireExplicitProjectId &&
      (effectiveProjectId === undefined || effectiveProjectId === null) &&
      resolveProjectIdFromCwd !== undefined;

    if (shouldResolveProjectFromCwd || shouldRequireExplicitProjectId) {
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
          'cwd_not_registered: MCP server cwd does not match any entry in the project registry; ' +
            'pass project_id explicitly or register the cwd as a project'
        );
      }
      if (requireExplicitProjectId) {
        throw new ProjectIdRequiredError(resolved);
      }
      if (effectiveProjectId === undefined) {
        effectiveProjectId = resolved;
        resolutionWarning = {
          code: 'project_id_inferred_from_mcp_cwd',
          resolved_project_id: resolved,
        };
      }
    }

    const body: Record<string, unknown> = {
      initial_agent: input.initial_agent,
      message: input.message,
    };
    if (input.conversation_id !== undefined) body.conversation_id = input.conversation_id;
    if (effectiveProjectId !== undefined && effectiveProjectId !== null) body.project_id = effectiveProjectId;
    if (input.max_hops !== undefined) body.max_hops = input.max_hops;
    if (input.trust_mode !== undefined) body.trust_mode = input.trust_mode;
    if (input.use_worktree !== undefined) body.use_worktree = input.use_worktree;
    if (input.task_type !== undefined) body.task_type = input.task_type;
    if (input.parent_handoff_id !== undefined) body.parent_handoff_id = input.parent_handoff_id;
    if (input.dispatch_kind !== undefined) body.dispatch_kind = input.dispatch_kind;
    if (input.long_lived_agent_id !== undefined) body.long_lived_agent_id = input.long_lived_agent_id;
    if (input.long_lived_tick_id !== undefined) body.long_lived_tick_id = input.long_lived_tick_id;
    if (input.branch_base !== undefined) body.branch_base = input.branch_base;
    if (input.open_pr_on_review !== undefined) body.open_pr_on_review = input.open_pr_on_review;
    if (input.task_class !== undefined) body.task_class = input.task_class;
    let routingWarning:
      | {
          code: string;
          projectId: string;
          mentionedPaths: string[];
          missingInProject: string[];
          suggestedProjectId?: string;
          hint: string;
        }
      | undefined;
    if (effectiveProjectId != null && opts.inspectPromptVsProject) {
      const guardResult = opts.inspectPromptVsProject({ prompt: input.message, project_id: effectiveProjectId });
      if (guardResult.status === 'mismatch') {
        const payload = {
          projectId: effectiveProjectId,
          mentionedPaths: guardResult.mentioned_paths,
          missingInProject: guardResult.missing_in_project,
          suggestedProjectId: guardResult.suggested_project_id,
          hint: 'pass --project_id explicitly or update prompt paths',
        };
        console.warn('chain_start prompt-vs-project mismatch', {
          project_id: effectiveProjectId,
          mentioned_paths: guardResult.mentioned_paths,
          missing_in_project: guardResult.missing_in_project,
          suggested_project_id: guardResult.suggested_project_id,
        });
        if (isEnvTruthy(process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH)) {
          throw new PromptProjectMismatchError(payload);
        }
        routingWarning = {
          code: 'prompt_project_mismatch',
          ...payload,
        };
      }
    }
    const res = await daemon.startChain(body as any);
    const response = {
      content: [{
        type: 'text',
        text: wrapWithSummary(
          formatChainStart({
            ...res,
            agent: input.initial_agent,
            trust_mode: input.trust_mode,
          }),
          res
        )
      }],
    };
    return {
      ...response,
      ...(resolutionWarning !== undefined ? { resolution_warning: resolutionWarning } : {}),
      ...(routingWarning !== undefined ? { routing_warning: routingWarning } : {}),
    };
  };
}
