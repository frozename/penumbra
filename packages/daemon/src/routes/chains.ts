import { z } from 'zod';
import type { ChainStartRequest, Services, CapCheckRefuse } from '@penumbra/core';
import { ChainStartRequestSchema, checkPressureCap, HandoffStatusSchema, inspectPromptVsProject, inferAgentTaskTypeForRole, insertLane, MaestroSessionWriter, routeAgent, type AgentRecommendation, type AgentTaskType, type RecallResult, type TaskClass, RecallRequestSchema } from '@penumbra/core';
import { ChainStartResponseSchema } from '@penumbra/api-contract';
import { supportsMidSessionInject, type AcpWorkerManagerLike } from '../maestro/acp-injector.js';
import { enforceMaestroBudget } from '../maestro/chain-budget-gate.js';
import { buildProviderCaps } from '../maestro/build-provider-caps.js';
import { autoRecallForDispatch } from '../dispatch/auto-recall.js';
import { stampPrompt } from '../long-lived/prompt-stamper.js';
import { resolveSingleRoute } from './role-routing.js';

import { json } from './_helpers.js';
interface InitialRoute {
  agent: string;
  role: string | null;
  taskType: AgentTaskType | null;
}

type AgentChatConfigLike = {
  agents?: Array<{
    name: string;
    pricing_mode?: 'api' | 'subscription';
    subscription_provider?: string;
    subscription_model?: string;
  }>;
};

type ChainStartRequestWithLongLived = Omit<ChainStartRequest, 'dispatch_kind'> & {
  open_pr_on_review?: boolean;
  dispatch_kind?: 'long_lived_tick' | 'workflow';
  workflow_run_id?: string;
  long_lived_agent_id?: string;
  long_lived_tick_id?: string;
  task_class?: TaskClass;
};

interface LongLivedPromptAgentRow {
  id: string;
  display_name: string;
  standing_brief: string;
  working_memory_json: string;
  mcp_allowlist_json: string;
  bounds_wall_clock_ms: number | null;
  bounds_cost_cents: number | null;
  bounds_max_sub_dispatches: number | null;
}

interface LongLivedPromptTickRow {
  id: string;
  agent_id: string;
  trigger_kind: 'cron' | 'event' | 'injected_goal' | 'manual';
  trigger_payload_json: string | null;
}

const MAX_SUB_DISPATCH_FALLBACKS = 2;

type RoutingWarningPayload = {
  code: 'prompt_project_mismatch';
  project_id: string;
  mentioned_paths: string[];
  missing_in_project: string[];
  suggested_project_id?: string;
  hint: string;
};

type RoutingAdvisoryPayload = {
  code: 'project_registry_unavailable';
};

function workerHeartbeatGuard(services: Services): Response | null {
  const timeoutMsStr = process.env.PENUMBRA_WORKER_HEARTBEAT_TIMEOUT_MS;
  const timeoutMs = timeoutMsStr ? parseInt(timeoutMsStr, 10) : 15000;
  if (services.watchdog.hasActiveWorker(timeoutMs)) return null;
  return json(
    {
      error: {
        code: 'no_worker_registered',
        message: "no agentchat-worker registered; start one via 'bun packages/agentchat/bin/agentchat-worker.ts --storage-root <root>'",
      },
    },
    503,
  );
}

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

type LongLivedTickExemptionResult = { ok: true; tick: { id: string; agent_id: string } } | { ok: false; reason: string };

export function resolveLongLivedTickExemption(
  services: Services,
  input: {
    dispatch_kind?: 'long_lived_tick' | 'workflow';
    long_lived_tick_id?: string | null;
    long_lived_agent_id?: string | null;
  },
): LongLivedTickExemptionResult {
  if (input.dispatch_kind !== 'long_lived_tick') {
    return { ok: false, reason: 'dispatch_kind_mismatch' };
  }
  if (!input.long_lived_tick_id) {
    return { ok: false, reason: 'missing_long_lived_tick_id' };
  }
  if (!input.long_lived_agent_id) {
    return { ok: false, reason: 'missing_long_lived_agent_id' };
  }
  const tick = services.db.query<
    { id: string; agent_id: string },
    [string]
  >(`SELECT id, agent_id FROM long_lived_ticks WHERE id = ? AND completed_at IS NULL LIMIT 1`).get(input.long_lived_tick_id);
  if (!tick) {
    return { ok: false, reason: 'unknown_or_completed_long_lived_tick' };
  }
  if (tick.agent_id !== input.long_lived_agent_id) {
    return { ok: false, reason: 'long_lived_agent_id_mismatch' };
  }
  return { ok: true, tick };
}

function resolveWorkflowDispatchExemption(
  services: Services,
  input: {
    dispatch_kind?: 'long_lived_tick' | 'workflow';
    workflow_run_id?: string | null;
    project_id?: string | null;
  },
): { ok: true; workflow_run_id: string } | { ok: false; reason: string } {
  if (input.dispatch_kind !== 'workflow') {
    return { ok: false, reason: 'dispatch_kind_mismatch' };
  }
  if (!input.workflow_run_id || !services.workflowRuns) {
    return { ok: false, reason: 'missing_workflow_run_id' };
  }
  const info = services.workflowRuns.verify(input.workflow_run_id);
  if (!info) return { ok: false, reason: 'unknown_workflow_run_id' };
  if (input.project_id != null && info.project_id !== null && info.project_id !== input.project_id) {
    return { ok: false, reason: 'workflow_project_id_mismatch' };
  }
  return { ok: true, workflow_run_id: input.workflow_run_id };
}

function canBypassExplicitProjectIdGate(input: ChainStartRequestWithLongLived, services: Services): boolean {
  const longLivedExemption = resolveLongLivedTickExemption(services, input);
  if (longLivedExemption.ok) return true;
  const workflowExemption = resolveWorkflowDispatchExemption(services, input);
  return workflowExemption.ok;
}

export async function chainStartFromInput(
  raw: unknown,
  services: Services,
  opts?: { applyMaestroBudgetGate?: boolean; requireActiveWorker?: boolean },
): Promise<Response> {
  const requireActiveWorker = opts?.requireActiveWorker ?? true;
  if (requireActiveWorker) {
    const workerGuard = workerHeartbeatGuard(services);
    if (workerGuard) return workerGuard;
  }

  const parsed = ChainStartRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  const openPrOnReviewField = readOptionalBooleanField(raw, 'open_pr_on_review');
  if (openPrOnReviewField.error) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: [{ path: ['open_pr_on_review'], message: openPrOnReviewField.error }],
      },
    }, 400);
  }

  const dispatchKindField = readOptionalDispatchKindField(raw, 'dispatch_kind');
  if (dispatchKindField.error) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: [{ path: ['dispatch_kind'], message: dispatchKindField.error }],
      },
    }, 400);
  }

  const longLivedAgentIdField = readOptionalStringField(raw, 'long_lived_agent_id');
  if (longLivedAgentIdField.error) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: [{ path: ['long_lived_agent_id'], message: longLivedAgentIdField.error }],
      },
    }, 400);
  }

  const longLivedTickIdField = readOptionalStringField(raw, 'long_lived_tick_id');
  if (longLivedTickIdField.error) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: [{ path: ['long_lived_tick_id'], message: longLivedTickIdField.error }],
      },
    }, 400);
  }

  const workflowRunIdField = readOptionalStringField(raw, 'workflow_run_id');
  if (workflowRunIdField.error) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: [{ path: ['workflow_run_id'], message: workflowRunIdField.error }],
      },
    }, 400);
  }

  const normalizedInput = parsed.data as ChainStartRequestWithLongLived;
  if (openPrOnReviewField.value !== undefined) {
    normalizedInput.open_pr_on_review = openPrOnReviewField.value;
  }
  if (dispatchKindField.value !== undefined) {
    normalizedInput.dispatch_kind = dispatchKindField.value;
  }
  if (longLivedAgentIdField.value !== undefined) {
    normalizedInput.long_lived_agent_id = longLivedAgentIdField.value;
  }
  if (longLivedTickIdField.value !== undefined) {
    normalizedInput.long_lived_tick_id = longLivedTickIdField.value;
  }
  if (workflowRunIdField.value !== undefined) {
    normalizedInput.workflow_run_id = workflowRunIdField.value;
  }
  if (normalizedInput.task_class === undefined) {
    services.log.debug({ event: 'dispatch.legacy_no_task_class' }, 'chain-start legacy dispatch without task_class');
  }

  return chainStartInternal(normalizedInput, services, {
    applyMaestroBudgetGate: opts?.applyMaestroBudgetGate ?? true,
  });
}

export async function chainsStartRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  return chainStartFromInput(raw, services, { applyMaestroBudgetGate: true, requireActiveWorker: true });
}

export async function chainStartInternal(
  input: ChainStartRequestWithLongLived,
  services: Services,
  opts?: { applyMaestroBudgetGate?: boolean },
): Promise<Response> {
  const applyMaestroBudgetGate = opts?.applyMaestroBudgetGate ?? false;
  const requireExplicitProjectId = isEnvTruthy(process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID);
  if (requireExplicitProjectId && (input.project_id === undefined || input.project_id === null)) {
    if (canBypassExplicitProjectIdGate(input, services)) {
      services.log.info(
        {
          event: 'chain_start.routing_guard.explicit_gate_exempted',
          dispatch_kind: input.dispatch_kind ?? null,
          long_lived_tick_id: input.long_lived_tick_id ?? null,
          workflow_run_id: input.workflow_run_id ?? null,
        },
        'chain-start explicit project_id gate exempted for internal hop',
      );
    } else {
    return json({
      error: 'project_id_required',
      hint: 'pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior',
    }, 400);
    }
  }

  let routingWarning: RoutingWarningPayload | undefined;
  let routingAdvisory: RoutingAdvisoryPayload | undefined;
  let projectRegistryEntries: Array<{ project_id: string; root_path: string }> | undefined;
  if (
    services.projectRegistry !== undefined &&
    input.project_id == null &&
    input.dispatch_kind === 'workflow' &&
    input.workflow_run_id &&
    isEnvTruthy(process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH)
  ) {
    const workflowRuns = services.workflowRuns;
    const info = workflowRuns?.verify(input.workflow_run_id) ?? null;
    services.log.warn(
      {
        event: 'chain_start.routing_guard.workflow_exemption_rejected',
        project_id: input.project_id,
        info_project_id: info?.project_id ?? null,
        request_project_id: input.project_id,
        workflow_run_id_present: true,
      },
      'workflow dispatch_kind without project_id; strict routing guard remains in effect',
    );
    return json({
      error: {
        code: 'prompt_project_mismatch',
        project_id: input.project_id,
        mentioned_paths: [],
        missing_in_project: [],
        hint: 'pass project_id explicitly or update prompt paths',
      },
    }, 400);
  }
  if (services.projectRegistry !== undefined && input.project_id != null) {
    try {
      projectRegistryEntries = services.projectRegistry.list();
      const guardResult = inspectPromptVsProject({
        prompt: input.message,
        project_id: input.project_id,
        registry: projectRegistryEntries,
      });
      if (guardResult.status === 'mismatch') {
        routingWarning = {
          code: 'prompt_project_mismatch',
          project_id: input.project_id,
          mentioned_paths: guardResult.mentioned_paths,
          missing_in_project: guardResult.missing_in_project,
          suggested_project_id: guardResult.suggested_project_id,
          hint: 'pass project_id explicitly or update prompt paths',
        };
        const parentHandoff = typeof input.parent_handoff_id === 'string'
          ? services.handoffReader.get(input.parent_handoff_id)
          : undefined;
        let workflowExemption = false;
        if (input.dispatch_kind === 'workflow') {
          const workflowExemptionResult = resolveWorkflowDispatchExemption(services, input);
          if (workflowExemptionResult.ok) {
            workflowExemption = true;
          }
          if (!workflowExemption) {
            services.log.warn(
              {
                event: 'chain_start.routing_guard.workflow_exemption_rejected',
                project_id: input.project_id,
                info_project_id: input.workflow_run_id && services.workflowRuns
                  ? services.workflowRuns.verify(input.workflow_run_id)?.project_id ?? null
                  : null,
                request_project_id: input.project_id,
                workflow_run_id_present: Boolean(input.workflow_run_id),
              },
              'workflow dispatch_kind without valid workflow_run_id; falling back to normal guard',
            );
          }
        }
        const longLivedExemptionResult = resolveLongLivedTickExemption(services, input);
        const isInternalHop = longLivedExemptionResult.ok ||
          workflowExemption ||
          (parentHandoff != null &&
            input.project_id != null &&
            parentHandoff.project_id != null &&
            parentHandoff.project_id === input.project_id);
        const logEvent = isInternalHop ? 'chain_start.routing_guard.internal_hop_mismatch' : 'chain_start.routing_guard.mismatch';
        services.log.warn(
          {
            event: logEvent,
            project_id: input.project_id,
            mentioned_paths: guardResult.mentioned_paths,
            missing_in_project: guardResult.missing_in_project,
            suggested_project_id: guardResult.suggested_project_id,
          },
          isInternalHop
            ? 'chain-start internal hop prompt/project mismatch'
            : 'chain-start prompt/project mismatch',
        );
        if (isEnvTruthy(process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH) && !isInternalHop) {
          return json({
            error: routingWarning,
          }, 400);
        }
      }
    } catch (err) {
      routingAdvisory = { code: 'project_registry_unavailable' };
      services.log.warn(
        {
          event: 'chain_start.routing_guard.registry_unavailable',
          project_id: input.project_id,
          error: err instanceof Error ? err.message : String(err),
        },
        'chain-start routing guard skipped because project registry was unavailable',
      );
    }
  }

  // P0.3b: Auto-strip leading @
  let initialAgent = input.initial_agent;
  if (initialAgent.startsWith('@')) {
    initialAgent = initialAgent.slice(1);
    input.initial_agent = initialAgent;
  }
  const forceExactAgent = initialAgent.startsWith('agent:');
  if (forceExactAgent) {
    initialAgent = initialAgent.slice('agent:'.length);
    input.initial_agent = initialAgent;
  }

  if (initialAgent.length < 1) {
    return json({
      error: {
        code: 'invalid_agent',
        agent: initialAgent,
        hint: 'initial_agent must be non-empty after @-prefix/agent:-prefix stripping',
      },
    }, 400);
  }

  let route = resolveInitialRoute({
    initialAgent,
    message: input.message,
    taskType: input.task_type,
    forceExactAgent,
    services,
  });

  // P0.3a: Validate initial_agent against registry
  if (!route && services.agentRegistry && !services.agentRegistry.includes(initialAgent)) {
    return json({
      error: {
        code: 'unknown_agent',
        agent: initialAgent,
        hint: 'use chain.list_agents to enumerate valid agents',
      },
    }, 400);
  }
  let routedAgent = route?.agent ?? initialAgent;
  let routedRole = route?.role ?? null;

  if (applyMaestroBudgetGate) {
    const maestroSessions = services.maestroSessions
      ?? new MaestroSessionWriter({
        db: services.db,
        now: () => services.clock().getTime(),
      });
    const budgetGate = enforceMaestroBudget({
      db: services.db,
      sessions: maestroSessions,
      parent_handoff_id: input.parent_handoff_id ?? undefined,
    });
    if (!budgetGate.ok) {
      return json(budgetGate.body, budgetGate.status);
    }
  }

  if (input.parent_handoff_id) {
    const parentToAgent = services.handoffReader.get(input.parent_handoff_id)?.to_agent;
    if (parentToAgent) {
      const cfg = services.agentchatConfig;
      const maestroAgent = cfg?.agents?.find((agent) => agent.name === parentToAgent);
      const subAgent = cfg?.agents?.find((agent) => agent.name === input.initial_agent);
      if (maestroAgent && subAgent) {
        const providerCaps = buildProviderCaps(services.providerQuotas);
        const gateChecks = [
          { subject: 'maestro' as const, agent: maestroAgent, agent_name: parentToAgent },
          { subject: 'sub_agent' as const, agent: subAgent, agent_name: input.initial_agent },
        ];

        for (const gate of gateChecks) {
          const outcome = checkPressureCap({
            cache: services.subscriptionPressureCache,
            agent: gate.agent,
            providerCaps: providerCaps as unknown as Parameters<typeof checkPressureCap>[0]['providerCaps'],
            now: () => services.clock(),
          });
          if (outcome.state === 'warn') {
            console.warn('subscription pressure warning', {
              provider: outcome.provider,
              window_label: outcome.window_label,
              used_pct: outcome.used_pct,
              warn_pct: outcome.warn_pct,
              refuse_pct: outcome.refuse_pct,
            });
            // Phase 2 will route warn outcomes into the bounds-tracker soft-warn path.
            continue;
          }
          if (outcome.state !== 'refuse') continue;

          let fallbackRefusedOutcomes: CapCheckRefuse[] = [];

          if (gate.subject === 'sub_agent' && cfg) {
            const fallback = maybeSelectSubDispatchFallback({
              services,
              input,
              cfg,
              providerCaps: providerCaps as unknown as Parameters<typeof checkPressureCap>[0]['providerCaps'],
              maestroAgentName: parentToAgent,
              refusedOutcome: outcome,
            });
            fallbackRefusedOutcomes = fallback.refusedOutcomes;

            if (fallback.selectedAgent) {
              initialAgent = fallback.selectedAgent;
              input.initial_agent = fallback.selectedAgent;
              route = resolveInitialRoute({
                initialAgent,
                message: input.message,
                taskType: input.task_type,
                forceExactAgent: true,
                services,
              });
              routedAgent = route?.agent ?? initialAgent;
              routedRole = route?.role ?? null;
              continue;
            }
          }

          const earliest_resets_at = earliestResetsAtForRefusals([outcome, ...fallbackRefusedOutcomes]);

          recordPressureCapTrip({
            services,
            input,
            subject: gate.subject,
            agent_name: gate.agent_name,
            maestro_agent_name: parentToAgent,
            sub_agent_name: input.initial_agent,
            outcome,
          });

          return json({
            error: {
              code: 'subscription_pressure_capped',
              subject: gate.subject,
              agent_name: gate.agent_name,
              provider: outcome.provider,
              window_label: outcome.window_label,
              used_pct: outcome.used_pct,
              cap_pct: outcome.cap_pct,
              resets_at: outcome.resets_at,
              earliest_resets_at,
              snapshot_state: outcome.snapshot_state,
              snapshot_age_seconds: outcome.snapshot_age_seconds,
            },
          }, 400);
        }
      }
    }
  }

  // Recursion depth guard: if parent_handoff_id is provided, walk the spawn
  // chain and reject if the new dispatch would exceed the cap. Reads env var
  // per-request (per observation 8351 — constructor-time latch is wrong).
  if (input.parent_handoff_id) {
    const cap = Number(process.env.PENUMBRA_RECURSION_DEPTH_CAP) || 8;
    const parentDepth = services.handoffReader.getSpawnDepth(input.parent_handoff_id);
    const newDepth = parentDepth + 1;
    if (newDepth >= cap) {
      return json({
        error: {
          code: 'recursion_depth_exceeded',
          message: `chain.start spawn depth ${newDepth} would meet/exceed cap ${cap}`,
          depth: newDepth,
          cap,
        },
      }, 409);
    }
  }

  if (
    input.project_id !== null &&
    input.project_id !== undefined &&
    projectRegistryEntries !== undefined &&
    projectRegistryEntries.length > 0 &&
    !projectRegistryEntries.some((entry) => entry.project_id === input.project_id)
  ) {
    services.log.warn(
      {
        project_id: input.project_id,
        known_project_ids: projectRegistryEntries.map((p) => p.project_id),
      },
      'chain-start unknown_project_id; dropping and continuing',
    );
    // Drop the bad project_id so downstream auto-resolution (from cwd, etc.) can run.
    // Hard-rejecting unknown project_id breaks long-lived ticks when the model
    // fills the optional field with its own agent identity (for example, "home-mgmt").
    (input as { project_id?: string }).project_id = undefined;
  }

  const conversation_id = input.conversation_id ?? `conv-${services.uuid()}`;
  const user_prompt_event_id = services.uuid();
  const handoff_id = services.uuid();
  const ts = services.clock().toISOString();
  const openPrOnReview = (input as { open_pr_on_review?: unknown }).open_pr_on_review;
  const openPrOnReviewBool = typeof openPrOnReview === 'boolean' ? openPrOnReview : undefined;
  const taskClass = (input as { task_class?: TaskClass }).task_class;
  if (taskClass !== undefined) {
    services.log.debug({ event: 'dispatch.task_class', task_class: taskClass }, 'chain-start dispatch task_class');
  }
  const stamped = buildStampedLongLivedPrompt(input, services);
  if (stamped.errorResponse) return stamped.errorResponse;
  let handoffMessage = stamped.message;
  let lane_id: string | null = null;
  let recalled_memory_ids: string[] = [];
  let recalled_query: string | null = null;

  if (taskClass !== undefined) {
    lane_id = `lane-${services.uuid()}`;
    const autoRecallEnabled = (() => {
      const v = process.env.PENUMBRA_AUTO_RECALL_ENABLED;
      if (v === undefined) return true;
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      services.log.warn({ event: 'dispatch.auto_recall_env_invalid', value: v }, `PENUMBRA_AUTO_RECALL_ENABLED='${v}' is not a recognized boolean; defaulting to enabled`);
      return true;
    })();

    if (!input.project_id) {
      services.log.debug({ event: 'dispatch.auto_recall_skipped_no_project_id', task_class: taskClass }, 'auto-recall skipped — no project_id on dispatch');
    } else if (autoRecallEnabled) {
      const AUTO_RECALL_TIMEOUT_MS = 1500;
      const autoPromise = autoRecallForDispatch(
        {
          prompt: input.message,
          task_class: taskClass,
          project_id: input.project_id,
        },
        {
          memoryRecall: async (args) => {
            const recallReq = RecallRequestSchema.parse({
              query: args.query,
              limit: args.top_k,
              project_id: args.project_id ?? null,
            });
            const results: RecallResult[] = await services.recallReader.recall(recallReq);
            return {
              hits: results.map((r) => ({
                id: r.id,
                title: r.title ?? '',
                snippet: r.body,
              })),
            };
          },
          logger: (level, msg, meta) => services.log[level]?.({ ...meta, event: 'dispatch.auto_recall' }, msg),
        },
      );
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), AUTO_RECALL_TIMEOUT_MS));
      const auto = await Promise.race([autoPromise, timeoutPromise]);
      if (auto === null) {
        services.log.warn({ event: 'dispatch.auto_recall_timeout', timeout_ms: AUTO_RECALL_TIMEOUT_MS }, 'auto-recall exceeded deadline — proceeding without injection');
      } else {
        recalled_memory_ids = auto.recalled_memory_ids;
        recalled_query = auto.recalled_query || null;
        if (auto.injected_text) {
          handoffMessage = `${auto.injected_text}\n\n${stamped.message}`;
        }
      }
    }
  }

  services.db.transaction(() => {
    services.t0Writer.write({
      event_id: user_prompt_event_id,
      ts, ingest_ts: ts,
      source: 'agentchat',
      source_detail: 'chain-start',
      project_id: input.project_id ?? null,
      user_id: 'local-user',
      machine_id: services.machineId.get(),
      session_id: conversation_id,
      event_type: 'user-prompt',
      lane: 'cli-subscription',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      payload_json: { prompt: input.message },
      payload_summary: input.message.slice(0, 240),
      origin: null,
    });

    services.handoffWriter.createApproved({
      handoff_id, ts,
      project_id: input.project_id ?? null,
      conversation_id,
      from: 'user',
      to: routedAgent,
      to_role: routedRole,
      message: handoffMessage,
      triggered_by_event_id: user_prompt_event_id,
      resolved_by: 'chain-start',
      resolved_at: null,
      chain_max_hops: input.max_hops ?? null,
      chain_trust_mode: input.trust_mode ?? null,
      chain_task_type: route?.taskType ?? input.task_type ?? null,
      dispatch_kind: input.dispatch_kind ?? null,
      long_lived_agent_id: input.long_lived_agent_id ?? null,
      long_lived_tick_id: input.long_lived_tick_id ?? null,
      use_worktree: input.use_worktree ?? true,
      parent_handoff_id: input.parent_handoff_id ?? null,
      branch_base: input.branch_base ?? null,
    } as any);
    if (openPrOnReviewBool !== undefined) {
      services.db.query<unknown, [number, string]>(
        `UPDATE handoffs SET open_pr_on_review=? WHERE handoff_id=?`,
      ).run(openPrOnReviewBool ? 1 : 0, handoff_id);
    }
    if (lane_id !== null && taskClass !== undefined) {
      insertLane(services.db, {
        lane_id,
        ts_opened: ts,
        task_class: taskClass,
        implementer_handoff: handoff_id,
        recalled_memory_ids,
        recalled_query,
      });
    }
  })();

  const body = {
    conversation_id,
    handoff_id,
    ...(taskClass !== undefined ? { task_class: taskClass, lane_id, recalled_memory_ids } : {}),
    ...(routedRole ? {
      routed_agent: routedAgent,
      routed_role: routedRole,
      routing_task_type: route?.taskType,
    } : {}),
    ...(routingWarning !== undefined ? { routing_warning: routingWarning } : {}),
    ...(routingAdvisory !== undefined ? { routing_advisory: routingAdvisory } : {}),
  };
  try {
    return json(ChainStartResponseSchema.parse(body));
  } catch (err) {
    services.log.error(
      {
        event: 'chain_start.response_schema_parse_failed',
        error: err instanceof Error ? err.message : String(err),
      },
      'chain-start response schema parse failed; returning unparsed body',
    );
    return json(body);
  }
}

function maybeSelectSubDispatchFallback(opts: {
  services: Services;
  input: ChainStartRequestWithLongLived;
  cfg: AgentChatConfigLike;
  providerCaps: Parameters<typeof checkPressureCap>[0]['providerCaps'];
  maestroAgentName: string;
  refusedOutcome: CapCheckRefuse;
}): { selectedAgent: string | null; refusedOutcomes: CapCheckRefuse[] } {
  if (!opts.input.parent_handoff_id) return { selectedAgent: null, refusedOutcomes: [] };
  if (!opts.input.task_type) return { selectedAgent: null, refusedOutcomes: [] };

  const refusedOutcomes: CapCheckRefuse[] = [];

  const route = routeAgent({
    db: opts.services.db,
    detail: 'summary',
    taskType: opts.input.task_type,
    windowDays: 7,
    now: opts.services.clock(),
  });
  if (route.detail !== 'summary') throw new Error('unexpected routeAgent detail for fallback recommendations');
  const recommendations: AgentRecommendation[] = route.recommendations;

  if (recommendations.length === 0) {
    recordPressureFallbackEvent({
      services: opts.services,
      input: opts.input,
      maestroAgentName: opts.maestroAgentName,
      originalAgentName: opts.input.initial_agent,
      candidateAgent: null,
      candidateState: 'exhausted',
      candidateOutcome: opts.refusedOutcome,
      attemptIndex: 0,
      totalAttempts: 0,
      ranking: null,
      exhaustedReason: 'no_recommendations',
    });
    return { selectedAgent: null, refusedOutcomes };
  }

  const configAgents = new Set((opts.cfg.agents ?? []).map((agent) => agent.name));
  const rankedCandidates = recommendations
    .filter((recommendation) => recommendation.agent_name !== opts.input.initial_agent)
    .filter((recommendation) => configAgents.has(recommendation.agent_name));

  let attemptCount = 0;
  for (const recommendation of rankedCandidates) {
    if (attemptCount >= MAX_SUB_DISPATCH_FALLBACKS) break;
    const candidate = opts.cfg.agents?.find((agent) => agent.name === recommendation.agent_name);
    if (!candidate) continue;
    const outcome = checkPressureCap({
      cache: opts.services.subscriptionPressureCache,
      agent: candidate,
      providerCaps: opts.providerCaps,
      now: () => opts.services.clock(),
    });

    if (outcome.state === 'refuse') {
      refusedOutcomes.push(outcome);
      recordPressureFallbackEvent({
        services: opts.services,
        input: opts.input,
        maestroAgentName: opts.maestroAgentName,
        originalAgentName: opts.input.initial_agent,
        candidateAgent: candidate.name,
        candidateState: 'refuse',
        candidateOutcome: outcome,
        attemptIndex: attemptCount,
        totalAttempts: null,
        ranking: recommendation,
      });
      attemptCount += 1;
      continue;
    }

    recordPressureFallbackEvent({
      services: opts.services,
      input: opts.input,
      maestroAgentName: opts.maestroAgentName,
      originalAgentName: opts.input.initial_agent,
      candidateAgent: candidate.name,
      candidateState: 'selected',
      candidateOutcome: outcome,
      attemptIndex: attemptCount,
      totalAttempts: null,
      ranking: recommendation,
    });
    attemptCount += 1;

    recordPressureFallbackEvent({
      services: opts.services,
      input: opts.input,
      maestroAgentName: opts.maestroAgentName,
      originalAgentName: opts.input.initial_agent,
      candidateAgent: candidate.name,
      candidateState: 'selected',
      candidateOutcome: outcome,
      attemptIndex: attemptCount,
      totalAttempts: attemptCount,
      ranking: recommendation,
      exhaustedReason: null,
    });
    return { selectedAgent: candidate.name, refusedOutcomes };
  }

  const exhaustedReason = attemptCount === 0 ? 'no_candidates' : 'all_refused';
  recordPressureFallbackEvent({
    services: opts.services,
    input: opts.input,
    maestroAgentName: opts.maestroAgentName,
    originalAgentName: opts.input.initial_agent,
    candidateAgent: null,
    candidateState: 'exhausted',
    candidateOutcome: opts.refusedOutcome,
    attemptIndex: attemptCount,
    totalAttempts: attemptCount,
    ranking: null,
    exhaustedReason,
  });
  return { selectedAgent: null, refusedOutcomes };
}

function earliestResetsAtForRefusals(outcomes: CapCheckRefuse[]): number | null {
  let earliest: number | null = null;
  for (const outcome of outcomes) {
    if (typeof outcome.resets_at !== 'number') continue;
    if (earliest === null || outcome.resets_at < earliest) {
      earliest = outcome.resets_at;
    }
  }
  return earliest;
}

function recordPressureCapTrip(opts: {
  services: Services;
  input: ChainStartRequestWithLongLived;
  subject: 'maestro' | 'sub_agent';
  agent_name: string;
  maestro_agent_name: string;
  sub_agent_name: string;
  outcome: CapCheckRefuse;
}): void {
  const ts = opts.services.clock().toISOString();
  const payload = {
    ...opts.outcome,
    subject: opts.subject,
    trigger: 'pre_dispatch',
    maestro_agent_name: opts.maestro_agent_name,
    sub_agent_name: opts.sub_agent_name,
  };

  opts.services.t0Writer.write({
    event_id: opts.services.uuid(),
    ts,
    ingest_ts: ts,
    source: 'agentchat',
    source_detail: 'chain-start',
    project_id: opts.input.project_id ?? null,
    user_id: 'local-user',
    machine_id: opts.services.machineId.get(),
    session_id: opts.input.conversation_id ?? null,
    event_type: 'subscription-pressure-cap-trip',
    lane: 'cli-subscription',
    provider: opts.outcome.provider,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: payload,
    payload_summary: `${opts.subject}:${opts.outcome.provider}:${opts.outcome.window_label}`,
    origin: 'maestro',
  });
}

function recordPressureFallbackEvent(opts: {
  services: Services;
  input: ChainStartRequestWithLongLived;
  maestroAgentName: string;
  originalAgentName: string;
  candidateAgent: string | null;
  candidateState: 'refuse' | 'selected' | 'exhausted';
  candidateOutcome: ReturnType<typeof checkPressureCap>;
  attemptIndex: number;
  totalAttempts: number | null;
  ranking: {
    samples: number;
    success_rate: number;
    avg_latency_seconds: number | null;
  } | null;
  exhaustedReason?: 'no_recommendations' | 'no_candidates' | 'all_refused' | null;
}): void {
  const ts = opts.services.clock().toISOString();
  const payload = {
    parent_handoff_id: opts.input.parent_handoff_id ?? null,
    task_type: opts.input.task_type ?? null,
    original_agent: opts.originalAgentName,
    candidate_agent: opts.candidateAgent,
    candidate_state: opts.candidateState,
    candidate_provider: 'provider' in opts.candidateOutcome ? opts.candidateOutcome.provider : null,
    candidate_window_label: 'window_label' in opts.candidateOutcome ? opts.candidateOutcome.window_label : null,
    candidate_used_pct: 'used_pct' in opts.candidateOutcome ? opts.candidateOutcome.used_pct : null,
    attempt_index: opts.attemptIndex,
    total_attempts: opts.totalAttempts,
    exhausted_reason: opts.exhaustedReason ?? null,
    ranking: opts.ranking,
    maestro_agent_name: opts.maestroAgentName,
    sub_agent_name: opts.input.initial_agent,
  };

  opts.services.t0Writer.write({
    event_id: opts.services.uuid(),
    ts,
    ingest_ts: ts,
    source: 'agentchat',
    source_detail: 'chain-start',
    project_id: opts.input.project_id ?? null,
    user_id: 'local-user',
    machine_id: opts.services.machineId.get(),
    session_id: opts.input.conversation_id ?? null,
    event_type: 'subscription-pressure-fallback',
    lane: 'cli-subscription',
    provider: payload.candidate_provider,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: payload,
    payload_summary: `${payload.original_agent}:${payload.candidate_state}:${payload.candidate_agent ?? 'none'}`,
    origin: 'maestro',
  });
}

export async function chainsHistoryRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get('conversation_id');
  if (!conversation_id) {
    return json({ error: { code: 'missing_param', message: 'conversation_id query parameter is required' } }, 400);
  }
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const history = services.chainReader.listHistory(conversation_id, limit);
  return json({ history });
}

export async function chainsResponsesRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get('conversation_id');
  if (!conversation_id) {
    return json({ error: { code: 'missing_param', message: 'conversation_id query parameter is required' } }, 400);
  }
  const whichParam = url.searchParams.get('which');
  const which = whichParam === 'all' ? 'all' : 'final';
  const responses = services.chainReader.getResponses(conversation_id, which);
  if (responses.length === 0 && !services.chainReader.conversationExists(conversation_id)) {
    return json({ error: { code: 'not_found', message: 'no chain events found for conversation' } }, 404);
  }
  return json({ responses });
}

export async function chainsMessagesRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get('conversation_id');
  if (!conversation_id) {
    return json({ error: { code: 'missing_param', message: 'conversation_id query parameter is required' } }, 400);
  }
  const typesParam = url.searchParams.get('types');
  const types = typesParam ? typesParam.split(',').map((t) => t.trim()).filter((t) => t.length > 0) : undefined;
  
  const events = services.chainReader.getMessages(conversation_id, types);
  return json({ events });
}

export async function chainSendMessageRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  }
  if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>).content !== 'string') {
    return json({ error: { code: 'validation_error', message: 'body must include content:string' } }, 400);
  }
  const { content } = raw as { content: string };
  const normalizedContent = content.trim();
  if (normalizedContent.length === 0) {
    return json({ error: { code: 'validation_error', message: 'content must be non-empty' } }, 400);
  }

  const handoff = services.handoffReader.get(handoff_id);
  if (!handoff) {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} not found` } }, 404);
  }
  if (isTerminalHandoffStatus(String(handoff.status))) {
    return json({ error: { code: 'gone', message: `handoff ${handoff_id} is no longer running` } }, 410);
  }

  const workerManager = services.workerManager;
  if (!workerManager || typeof workerManager.lookupSession !== 'function') {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} not found` } }, 404);
  }

  const rawSession = await workerManager.lookupSession(handoff_id);
  if (!rawSession) {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} not found` } }, 404);
  }
  const session = rawSession as {
    adapter?: string | null;
    adapter_kind?: string | null;
    metadata?: { adapter?: string | null; adapter_kind?: string | null } | null;
    worker?: { adapter?: string | null; adapter_kind?: string | null } | null;
    inject?: (msg: { role: string; text: string }) => Promise<unknown> | unknown;
  };
  const adapterId = resolveAdapterId(session);
  if (!supportsMidSessionInject(adapterId)) {
    return json(
      {
        error: {
          code: 'unsupported_adapter',
          message: `adapter does not support mid-session inject: ${adapterId || 'unknown'}`,
        },
      },
      409,
    );
  }
  if (typeof session.inject !== 'function') {
    return json(
      {
        error: {
          code: 'unsupported_adapter',
          message: `adapter does not support mid-session inject: ${adapterId || 'unknown'}`,
        },
      },
      409,
    );
  }

  await session.inject({ role: 'user', text: normalizedContent });
  return json({ ok: true });
}

export async function chainsListAgentsRoute(_req: Request, services: Services): Promise<Response> {
  const agents = (services.agentRegistry ?? []).map((name) => ({ name }));
  return json({ agents });
}

const ChainsListQuerySchema = z.object({
  status: HandoffStatusSchema.optional(),
  project_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
}).strict();

export async function chainsListRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = ChainsListQuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    project_id: url.searchParams.get('project_id') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!parsed.success) {
    return json({
      error: {
        code: 'invalid_input',
        details: parsed.error.issues,
      },
    }, 400);
  }
  const limit = parsed.data.limit ?? 100;
  const offset = parsed.data.offset ?? 0;
  const chains = services.chainReader.listChains({
    status: parsed.data.status,
    project_id: parsed.data.project_id,
    limit,
    offset,
  });
  return json({ chains, limit, offset });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}

function resolveAdapterId(session: { adapter?: string | null; adapter_kind?: string | null; metadata?: { adapter?: string | null; adapter_kind?: string | null } | null; worker?: { adapter?: string | null; adapter_kind?: string | null } | null; }): string {
  return session.adapter ?? session.adapter_kind ?? session.metadata?.adapter ?? session.metadata?.adapter_kind ?? session.worker?.adapter ?? session.worker?.adapter_kind ?? '';
}

function readOptionalBooleanField(raw: unknown, field: string): { value: boolean | undefined; error?: string } {
  if (!raw || typeof raw !== 'object') return { value: undefined };
  const value = (raw as Record<string, unknown>)[field];
  if (value === undefined) return { value: undefined };
  if (typeof value === 'boolean') return { value };
  return { value: undefined, error: 'Invalid input: expected boolean, received non-boolean' };
}

function readOptionalStringField(raw: unknown, field: string): { value: string | undefined; error?: string } {
  if (!raw || typeof raw !== 'object') return { value: undefined };
  const value = (raw as Record<string, unknown>)[field];
  if (value === undefined) return { value: undefined };
  if (typeof value === 'string' && value.length > 0) return { value };
  return { value: undefined, error: 'Invalid input: expected non-empty string, received non-string or empty value' };
}

function readOptionalDispatchKindField(raw: unknown, field: string): { value: 'long_lived_tick' | 'workflow' | undefined; error?: string } {
  const parsed = readOptionalStringField(raw, field);
  if (parsed.error) return { value: undefined, error: parsed.error };
  if (parsed.value === undefined) return { value: undefined };
  if (parsed.value === 'long_lived_tick' || parsed.value === 'workflow') return { value: parsed.value };
  return { value: undefined, error: "Invalid input: expected 'long_lived_tick' or 'workflow'" };
}

function buildStampedLongLivedPrompt(input: ChainStartRequestWithLongLived, services: Services): {
  message: string;
  errorResponse?: Response;
} {
  if (input.dispatch_kind !== 'long_lived_tick') {
    return { message: input.message };
  }

  const agentId = input.long_lived_agent_id ?? null;
  if (!agentId) {
    return {
      message: input.message,
      errorResponse: json({
        error: {
          code: 'unknown_long_lived_agent',
          message: 'long-lived dispatch requires a resolvable agent',
          long_lived_agent_id: input.long_lived_agent_id ?? null,
        },
      }, 400),
    };
  }
  const tickId = input.long_lived_tick_id ?? null;
  if (!tickId) {
    return {
      message: input.message,
      errorResponse: json({
        error: {
          code: 'unknown_long_lived_tick',
          message: 'long-lived dispatch requires a resolvable tick',
          long_lived_tick_id: input.long_lived_tick_id ?? null,
        },
      }, 400),
    };
  }

  const agent = services.db.query<LongLivedPromptAgentRow, [string]>(
    `SELECT id, display_name, standing_brief, working_memory_json, mcp_allowlist_json,
            bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches
     FROM long_lived_agents
     WHERE id = ?
     LIMIT 1`,
  ).get(agentId);
  if (!agent) {
    return {
      message: input.message,
      errorResponse: json({
        error: {
          code: 'unknown_long_lived_agent',
          message: `long-lived agent not found: ${agentId}`,
          long_lived_agent_id: agentId,
        },
      }, 400),
    };
  }

  const tick = services.db.query<LongLivedPromptTickRow, [string]>(
    `SELECT id, agent_id, trigger_kind, trigger_payload_json
     FROM long_lived_ticks
     WHERE id = ?
     LIMIT 1`,
  ).get(tickId);
  if (!tick) {
    return {
      message: input.message,
      errorResponse: json({
        error: {
          code: 'unknown_long_lived_tick',
          message: `long-lived tick not found: ${tickId}`,
          long_lived_tick_id: tickId,
        },
      }, 400),
    };
  }
  if (tick.agent_id !== agent.id) {
    return {
      message: input.message,
      errorResponse: json({
        error: {
          code: 'cross_identity_long_lived',
          message: 'long-lived tick does not belong to the provided agent',
          long_lived_agent_id: agentId,
          long_lived_tick_id: tickId,
        },
      }, 400),
    };
  }

  const agentHostedNames = new Set<string>();
  for (const entry of parseJsonWithFallback<string[]>(agent.mcp_allowlist_json, [])) {
    const separator = entry.includes(':') ? entry.indexOf(':') : entry.indexOf('.');
    if (separator <= 0) continue;
    const server = entry.slice(0, separator);
    if (server) agentHostedNames.add(server);
  }
  const unavailableServers = agentHostedNames.size > 0 && services.mcpPool
    ? services.mcpPool.getFederationHealth().skipped
      .filter((s) => agentHostedNames.has(s.server))
      .map((s) => s.server)
    : [];

  return {
    message: stampPrompt({
      agent: {
        id: agent.id,
        display_name: agent.display_name,
        standing_brief: agent.standing_brief,
        working_memory: parseJsonWithFallback(agent.working_memory_json, {
          version: 1,
          updated_at: services.clock().getTime(),
          pending_goals: [],
          open_threads: [],
          watches: [],
          recent_decisions: [],
        }),
        mcp_allowlist: parseJsonWithFallback<string[]>(agent.mcp_allowlist_json, []),
        unavailable_servers: unavailableServers,
        bounds: {
          wall_clock_ms: agent.bounds_wall_clock_ms ?? 1_800_000,
          cost_cents: agent.bounds_cost_cents ?? 200,
          max_sub_dispatches: agent.bounds_max_sub_dispatches ?? 10,
        },
      },
      tick: {
        id: tick.id,
        trigger_kind: tick.trigger_kind,
        trigger_payload: parseJsonWithFallback<unknown>(tick.trigger_payload_json, null),
        now_iso: services.clock().toISOString(),
      },
    }),
  };
}

function parseJsonWithFallback<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isTerminalHandoffStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'rejected';
}

function resolveInitialRoute(opts: {
  initialAgent: string;
  message: string;
  taskType?: AgentTaskType;
  forceExactAgent: boolean;
  services: Services;
}): InitialRoute | null {
  const { agentRegistry, agentRouting } = opts.services;
  const roleAgents = (agentRouting?.agents ?? [])
    .filter((agent) => agent.roles.includes(opts.initialAgent))
    .map((agent) => agent.name)
    .filter((name) => !agentRegistry || agentRegistry.includes(name));
  if (!opts.forceExactAgent && agentRouting && roleAgents.length > 0) {
    return resolveRoleRoute(opts, roleAgents);
  }

  if (agentRegistry?.includes(opts.initialAgent)) {
    return { agent: opts.initialAgent, role: null, taskType: null };
  }
  return null;
}

function resolveRoleRoute(opts: {
  initialAgent: string;
  message: string;
  taskType?: AgentTaskType;
  services: Services;
}, roleAgents: string[]): InitialRoute {
  const taskType = opts.taskType ?? inferTaskTypeForRole(opts.message, opts.initialAgent);
  const route = resolveSingleRoute(opts.services, opts.initialAgent, opts.message, taskType);
  return route ?? { agent: roleAgents[0]!, role: opts.initialAgent, taskType };
}

function inferTaskTypeForRole(message: string, role: string): AgentTaskType {
  return inferAgentTaskTypeForRole(message, role);
}
