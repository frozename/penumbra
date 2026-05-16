import {
  type ExtractStumblesInput,
  extractStumblesFromSession,
  TaskDraftPayloadSchema,
  type Services,
  resolveProjectScope,
} from '@penumbra/core';
import type { Registry, TemplateVarContext, WorkflowSpec } from '@penumbra/workflows';
import {
  buildWorkflowCtx,
  composeRecall,
  executeWorkflow,
  evaluateTriggerEvent,
  evaluateStateThresholds,
  computeStateMetrics,
} from '@penumbra/workflows';
import { lookupSessionStart } from './sessions.js';
import { chainStartFromInput } from './chains.js';

import { json } from './_helpers.js';
const SESSION_START_FALLBACK_MS = 8 * 60 * 60 * 1000;

const MAX_EVENTS_SCANNED_DEFAULT = 500;
const EVENT_TIME_WINDOW_MS_DEFAULT = 86_400_000;

export const MAX_DRAFTS_PER_SESSION = 20;

function resolveSessionStart(
  db: import('bun:sqlite').Database | undefined,
  sessionId: string | null | undefined,
  now: number,
): string {
  if (sessionId && db) {
    const stored = lookupSessionStart(db, sessionId);
    if (stored) return stored;
  }
  return new Date(now - SESSION_START_FALLBACK_MS).toISOString();
}

// The Services interface in @penumbra/core types workflowRegistry with the default
// `WorkflowRegistry<unknown, unknown>` because core can't depend on the workflows
// package. Cast to the concrete Registry at the route boundary so spec types flow.
function getRegistry(services: Services): Registry | undefined {
  return services.workflowRegistry as Registry | undefined;
}

type InputSchemaIssue = {
  path?: ReadonlyArray<PropertyKey>;
  message?: string;
  expected?: unknown;
};

type InputSchemaLike = {
  safeParse: (
    input: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: ReadonlyArray<InputSchemaIssue> } };
};

function isInputSchemaLike(schema: unknown): schema is InputSchemaLike {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  );
}

function invalidArgs(issues: ReadonlyArray<InputSchemaIssue>): Response {
  return json(
    {
      error: {
        code: 'invalid_args',
        message: 'workflow input validation failed',
        issues: issues.map((issue) => ({
          path: Array.isArray(issue.path)
            ? issue.path.map((part) => (typeof part === 'number' ? part : String(part)))
            : [],
          message: issue.message ?? 'invalid input',
          expected: issue.expected,
        })),
      },
    },
    400,
  );
}

function untrustedCwd(): Response {
  return json({ error: { code: 'untrusted_cwd' } }, 400);
}

const SYNTHETIC_PROJECT_ID_WARNING =
  'workflow project_id resolved to synthetic git-id; consider adding to projects.yaml';

type WorkflowScopeResolution =
  | { ok: true; project: string; repoRoot: string }
  | { ok: false; response: Response };

type ProjectScopeLike =
  | { kind: 'registered'; project_id: string; repo_root: string }
  | { kind: 'no_match'; project_id: string; repo_root: string }
  | { kind: 'registry_unavailable'; project_id: string; repo_root: string }
  | { kind: 'global'; project_id: null; repo_root: null };

function resolveWorkflowScopeOrReject(cwd: string, services: Services): WorkflowScopeResolution {
  const scope = resolveProjectScope({ cwd, registry: services.projectRegistry }) as ProjectScopeLike;
  if (scope.kind === 'global') return { ok: false, response: untrustedCwd() };
  if (scope.kind === 'registry_unavailable') {
    services.log?.error?.(
      { cwd, resolved_project_id: scope.project_id, repo_root: scope.repo_root },
      'project registry is unavailable while resolving workflow scope',
    );
    return {
      ok: false,
      response: json(
        {
          error: {
            code: 'registry_unavailable',
            message: 'project registry is unavailable; cannot resolve workflow scope',
          },
        },
        503,
      ),
    };
  }
  if (scope.kind === 'no_match') {
    services.log?.warn?.(
      { cwd, resolved_project_id: scope.project_id, repo_root: scope.repo_root },
      SYNTHETIC_PROJECT_ID_WARNING,
    );
  }
  return { ok: true, project: scope.project_id, repoRoot: scope.repo_root };
}

function validateWorkflowArgs(
  entry: { source: 'markdown' | 'ts'; inputSchema?: unknown },
  rawArgs: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; response: Response } {
  if (entry.source !== 'ts' || !isInputSchemaLike(entry.inputSchema)) {
    return { ok: true, args: rawArgs };
  }
  const parsed = entry.inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, response: invalidArgs(parsed.error.issues) };
  }
  return { ok: true, args: parsed.data as Record<string, unknown> };
}

async function fileTaskDraftObservation(services: Services, input: {
  sessionId: string;
  projectId: string | null;
  prompt: string;
  affects_projects: string[];
  evidence: { conv_ids: string[]; commits: string[]; files: string[]; session_id: string };
  provenance?: {
    filing_path: string;
    session_id: string;
    extractor_version: string;
    filtered_by: string[];
  };
}): Promise<void> {
  const machineId = services.machineId.get();
  const maybePayload: Record<string, unknown> = {
    draft_id: services.uuid(),
    prompt: input.prompt,
    affects_projects: input.affects_projects,
    evidence: input.evidence,
    auto_ok: false,
    filed_by_agent: 'session-summarize-stop-hook',
    filed_via: 'stop_hook',
    parent_draft_id: null,
  };
  if (input.provenance) {
    maybePayload.provenance = input.provenance;
  }
  let payloadJson: ReturnType<typeof TaskDraftPayloadSchema.parse>;
  try {
    payloadJson = TaskDraftPayloadSchema.parse(maybePayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    services.log?.error?.({ err: msg, session_id: input.sessionId }, 'session-summarize task draft payload invalid');
    return;
  }

  const event = {
    event_id: services.uuid(),
    ts: new Date().toISOString(),
    ingest_ts: new Date().toISOString(),
    source: 'daemon' as const,
    source_detail: 'workflow:session-summarize',
    project_id: input.projectId,
    user_id: 'penumbra',
    machine_id: machineId,
    session_id: input.sessionId,
    event_type: 'task_draft' as const,
    lane: 'unknown' as const,
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: payloadJson,
    payload_summary: input.prompt.slice(0, 240),
    origin: 'unknown' as const,
  };
  services.t0Writer.write(event);
}

export async function fileSessionSummarizeStumbles(opts: {
  services: Services;
  sessionId: string;
  project: string;
  extractor?: typeof extractStumblesFromSession;
  filer?: typeof fileTaskDraftObservation;
  eventReader?: ExtractStumblesInput['dispatch_events_query'];
}): Promise<void> {
  const extractor = opts.extractor ?? extractStumblesFromSession;
  const filer = opts.filer ?? fileTaskDraftObservation;
  const now = Date.now();
  const timeCutoff = new Date(now - EVENT_TIME_WINDOW_MS_DEFAULT).toISOString();
  const maxEvents = MAX_EVENTS_SCANNED_DEFAULT;

  const eventReader = opts.eventReader ??
    (opts.services.db
      ? (sessionId: string) => {
          const rows = opts.services.db!
            .query(
              `SELECT source, event_type, payload_json
                 FROM t0_events
                WHERE session_id = ? AND ts >= ?
                  AND (source_detail IS NULL OR source_detail NOT LIKE 'workflow:%')
                ORDER BY ts ASC, event_id ASC
                LIMIT ?`,
            )
            .all(sessionId, timeCutoff, maxEvents + 1) as Array<{ source: string; event_type: string; payload_json: string | null }>;
          if (rows.length > maxEvents) {
            opts.services.log?.warn?.(
              { session_id: sessionId, limit: maxEvents, total: rows.length },
              'session-summarize event scan exceeded cap; truncating',
            );
            return rows.slice(0, maxEvents);
          }
          return rows;
        }
      : undefined);
  try {
    const candidates = await extractor({
      session_id: opts.sessionId,
      dispatch_events_query: eventReader,
      default_project: opts.project,
      allowed_sources: ['mcp', 'transcript', 'agentchat'],
      allowed_event_types: ['agent-prompt', 'agent-response', 'user-prompt'],
      max_events_scanned: maxEvents,
      event_time_window_ms: EVENT_TIME_WINDOW_MS_DEFAULT,
    } as ExtractStumblesInput);

    const capped = candidates.slice(0, MAX_DRAFTS_PER_SESSION);
    if (candidates.length > MAX_DRAFTS_PER_SESSION) {
      const dropped = candidates.slice(MAX_DRAFTS_PER_SESSION);
      const droppedHeuristics = dropped.map((c) => c.prompt.slice(0, 60)).join('; ');
      opts.services.log?.warn?.(
        {
          session_id: opts.sessionId,
          total: candidates.length,
          cap: MAX_DRAFTS_PER_SESSION,
          dropped_count: dropped.length,
          dropped_heuristics: droppedHeuristics,
        },
        'session-summarize stumble drafts exceeded session cap; keeping first N',
      );
    }

    const provenance = {
      filing_path: 'stop_hook',
      session_id: opts.sessionId,
      extractor_version: 'v1',
      filtered_by: ['source_allowlist', 'type_allowlist', 'time_window'],
    };

    for (const candidate of capped) {
      try {
        await filer(opts.services, {
          sessionId: opts.sessionId,
          projectId: opts.project !== 'unknown' ? opts.project : null,
          prompt: candidate.prompt,
          affects_projects: candidate.affects_projects,
          evidence: candidate.evidence,
          provenance,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.services.log?.error?.({ err: msg, session_id: opts.sessionId }, 'session-summarize stumble filing failed');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.services.log?.error?.({ err: msg, session_id: opts.sessionId }, 'session-summarize stumble extraction failed');
  }
}

export async function workflowsListRoute(_req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) return json({ workflows: [] });
  return json({
    workflows: reg.list().map((spec) => ({
      name: spec.name,
      description: spec.description,
      triggers: spec.triggers,
    })),
    errors: reg.errors,
  });
}

export async function workflowsRunRoute(req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) return json({ error: { code: 'no_registry', message: 'workflow registry not configured' } }, 500);

  const body = (await req.json().catch(() => null)) as
    | { name?: string; cwd?: string; session_id?: string | null; args?: Record<string, unknown> }
    | null;
  const name = body?.name;
  if (!name) return json({ error: { code: 'bad_request', message: 'name required' } }, 400);

  const entry = reg.getEntry(name);
  if (!entry) return json({ error: { code: 'not_found', message: `workflow ${name} not found` } }, 404);
  const rawArgs = body?.args ?? {};
  const argsResult = validateWorkflowArgs(entry, rawArgs);
  if (!argsResult.ok) return argsResult.response;
  const args = argsResult.args;

  const cwd = body?.cwd ?? process.cwd();
  const scope = resolveWorkflowScopeOrReject(cwd, services);
  if (!scope.ok) return scope.response;
  const { project, repoRoot } = scope;

  const start = Date.now();
  const sessionStart = resolveSessionStart((services as any).db, body?.session_id ?? null, start);
  const templateCtx: TemplateVarContext = {
    now: () => new Date(),
    project,
    sessionStart,
    tz: process.env.TZ ?? 'UTC',
    args,
    repoRoot,
  };
  const agentRegistry = (services as any).agentRegistry
    ? { listAgents: () => ((services as any).agentRegistry as string[]).map((name) => ({ name })) }
    : undefined;
  const workflowRuns = (services as Services & { workflowRuns?: { register: (workflowName: string, projectId: string | null) => string; unregister: (workflowRunId: string) => void } }).workflowRuns;
  const workflowRunId = workflowRuns?.register(name, project) ?? null;
  try {
    const bundle = await composeRecall({
      db: (services as any).db,
      embedder: (services as any).embedder,
      cwd,
      project,
      sources: entry.spec.recall,
      budgetTokens: entry.spec.recall_budget_tokens,
      agentRegistry,
      templateCtx,
      storageRoot: (services as any).storageRoot ?? (services as any).settings?.storageRoot,
    });

    const result = await executeWorkflow({
      spec: entry.spec,
      bundle,
      fn: entry.fn as any,
      ctx:
        entry.source === 'ts'
          ? buildWorkflowCtx({
              services,
              cwd,
              storageRoot: (services as any).storageRoot ?? (services as any).settings?.storageRoot ?? '/tmp',
              project,
              agentchatConfig: (services as any).agentchatConfig ?? ({} as Parameters<typeof buildWorkflowCtx>[0]['agentchatConfig']),
              args,
              workflowRunId,
              chainStart: (input) => chainStartFromInput(input, services, { applyMaestroBudgetGate: true }),
            } as Parameters<typeof buildWorkflowCtx>[0])
          : undefined,
      storageRoot: (services as any).storageRoot ?? (services as any).settings?.storageRoot ?? '/tmp',
      captureCtx: {
        db: (services as any).db,
        project,
        sessionId: 'daemon-direct',
        userId: 'penumbra',
        machineId: process.env.HOSTNAME ?? 'unknown',
      },
      repoRoot,
    });
    return json(result);
  } finally {
    if (workflowRunId) workflowRuns?.unregister(workflowRunId);
  }
}

export async function workflowsTriggerRoute(req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) return json({ matched: [], additionalContext: null });
  const body = (await req.json().catch(() => null)) as
    | {
        event?: any;
        cwd?: string;
        args?: Record<string, unknown>;
        hookContext?: { tool_name?: string | null; file_path?: string | null };
      }
    | null;
  const sessionIdFromBody = (body as { session_id?: string | null } | null)?.session_id ?? null;
  const filePathFromBody =
    typeof body?.hookContext?.file_path === 'string' ? body.hookContext.file_path : null;
  if (!body?.event) return json({ error: { code: 'bad_request', message: 'event required' } }, 400);
  const matched = evaluateTriggerEvent(reg, body.event).filter((spec: WorkflowSpec) => {
    for (const trigger of spec.triggers) {
      if (trigger.kind !== 'lifecycle') continue;
      if (trigger.event !== body.event.event) continue;
      const filter = trigger.filter;
      if (!filter?.tool_name) return true;
      const toolName = body.hookContext?.tool_name;
      if (typeof toolName !== 'string') return false;
      return filter.tool_name.includes(toolName);
    }
    return false;
  });

  const cwd = body.cwd ?? process.cwd();
  const scope = resolveWorkflowScopeOrReject(cwd, services);
  if (!scope.ok) return scope.response;
  const { project, repoRoot } = scope;

  const additionalContextParts: string[] = [];
  for (const spec of matched) {
    const entry = reg.getEntry(spec.name);
    if (!entry) continue;
    const rawArgs = body?.args ?? {};
    const argsResult = validateWorkflowArgs(entry, rawArgs);
    if (!argsResult.ok) return argsResult.response;
    const args = argsResult.args;
    const start = Date.now();
    const sessionStart = resolveSessionStart((services as any).db, sessionIdFromBody, start);
    const templateCtx: TemplateVarContext = {
      now: () => new Date(),
      project,
      sessionStart,
      tz: process.env.TZ ?? 'UTC',
      cwd,
      repoRoot,
      filePath: filePathFromBody ?? undefined,
      args,
    };
    const agentRegistry = (services as any).agentRegistry
      ? { listAgents: () => ((services as any).agentRegistry as string[]).map((name) => ({ name })) }
      : undefined;
    const workflowRuns = (services as Services & { workflowRuns?: { register: (workflowName: string, projectId: string | null) => string; unregister: (workflowRunId: string) => void } }).workflowRuns;
    const workflowRunId = workflowRuns?.register(spec.name, project) ?? null;
    try {
      const bundle = await composeRecall({
        db: (services as any).db,
        embedder: (services as any).embedder,
        cwd,
        project,
        sources: entry.spec.recall,
        budgetTokens: entry.spec.recall_budget_tokens,
        agentRegistry,
        templateCtx,
        storageRoot: (services as any).storageRoot ?? (services as any).settings?.storageRoot,
      });
      const result = await executeWorkflow({
        spec: entry.spec,
        bundle,
        fn: entry.fn as any,
        ctx:
          entry.source === 'ts'
          ? buildWorkflowCtx({
              services,
              cwd,
              storageRoot: (services as any).storageRoot ?? (services as any).settings?.storageRoot ?? '/tmp',
              project,
              agentchatConfig: (services as any).agentchatConfig ?? ({} as Parameters<typeof buildWorkflowCtx>[0]['agentchatConfig']),
              args,
              workflowRunId,
              chainStart: (input) => chainStartFromInput(input, services, { applyMaestroBudgetGate: true }),
            } as Parameters<typeof buildWorkflowCtx>[0])
            : undefined,
        storageRoot: (services as any).storageRoot ?? (services as any).settings?.storageRoot ?? '/tmp',
        captureCtx: {
          db: (services as any).db,
          project,
          sessionId: 'hook-trigger',
          userId: 'penumbra',
          machineId: process.env.HOSTNAME ?? 'unknown',
        },
        repoRoot,
        observationCtx: {
          sessionId: sessionIdFromBody,
          projectId: project !== 'unknown' ? project : null,
        },
        templateCtx,
      });
      if (result.sessionReminder) additionalContextParts.push(result.sessionReminder);
    } finally {
      if (workflowRunId) workflowRuns?.unregister(workflowRunId);
    }
  }

  if (matched.some((spec) => spec.name === 'session-summarize') && sessionIdFromBody) {
    await fileSessionSummarizeStumbles({
      services,
      sessionId: sessionIdFromBody,
      project,
    });
  }

  const additionalContext = additionalContextParts.length ? additionalContextParts.join('\n\n') : null;
  return json({ matched: matched.map((s) => s.name), additionalContext });
}

export async function workflowsHistoryRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const name = url.searchParams.get('name');
  if (!name) return json({ error: { code: 'bad_request', message: 'name required' } }, 400);
  const db = (services as any).db;
  const stats = db.query('SELECT * FROM workflow_stats WHERE workflow_name = ?').get(name);
  const recent = db
    .query(`SELECT ts, event_type, payload_json FROM t0_events WHERE event_type = 'workflow.outcome' AND json_extract(payload_json, '$.workflow_name') = ? ORDER BY ts DESC LIMIT 20`)
    .all(name);
  return json({ stats: stats ?? null, recent });
}

export async function workflowsSuggestRoute(req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) return json({ suggestions: [], metrics: { 'queue-idle-min': 0, 'time-since-last-handoff-min': 0, 'pending-handoffs': 0, 'commits-since-last-handoff': 0 } });
  const body = (await req.json().catch(() => ({}))) as { now?: string };
  const now = body.now ? new Date(body.now) : new Date();
  const metrics = computeStateMetrics({ db: (services as any).db, now: () => now });
  const suggestions = evaluateStateThresholds(reg, metrics).map((s) => ({
    name: s.name,
    description: s.description,
    triggers: s.triggers,
  }));
  return json({ suggestions, metrics });
}
