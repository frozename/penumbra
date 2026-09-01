import type {
  AgentChatConfigLike,
  Registry,
  TemplateVarContext,
  Trigger,
  WorkflowSpec,
} from "@penumbra/workflows";

import {
  extractStumblesFromSession,
  type ExtractStumblesInput,
  resolveProjectScope,
  type Services,
  type SessionEventKind,
  TaskDraftPayloadSchema,
} from "@penumbra/core";
import {
  buildWorkflowCtx,
  composeRecall,
  computeStateMetrics,
  evaluateStateThresholds,
  evaluateTriggerEvent,
  executeWorkflow,
} from "@penumbra/workflows";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import { json } from "./_helpers.js";
import { chainStartFromInput } from "./chains.js";
import { conversationsCancelRoute } from "./conversations.js";
import { lookupSessionStart } from "./sessions.js";
const SESSION_START_FALLBACK_MS = 8 * 60 * 60 * 1000;

const MAX_EVENTS_SCANNED_DEFAULT = 500;
const EVENT_TIME_WINDOW_MS_DEFAULT = 86_400_000;
const SKELETON_STAMP_READ_LIMIT_BYTES = 4096;

export const MAX_DRAFTS_PER_SESSION = 20;

function resolveSessionStart(
  db: import("bun:sqlite").Database | undefined,
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

function warnRegistryUnavailable(services: Services, route: string): void {
  services.log.warn(
    { route, workflow_registry: "unavailable" },
    "workflow registry unset; returning benign empty response",
  );
}

// Services typed agentchatConfig has a different agent element shape (strict
// fields) than the AgentChatConfigLike workflows accepts (Record<string,unknown>[]).
// Adapt at the route boundary via a single typed helper.
function asAgentChatConfigLike(cfg: Services["agentchatConfig"] | undefined): AgentChatConfigLike {
  return cfg ?? {};
}

type InputSchemaIssue = {
  path?: readonly PropertyKey[];
  message?: string;
  expected?: unknown;
};

type InputSchemaLike = {
  safeParse: (
    input: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly InputSchemaIssue[] } };
};

function isInputSchemaLike(schema: unknown): schema is InputSchemaLike {
  return (
    typeof schema === "object" &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

function invalidArgs(issues: readonly InputSchemaIssue[]): Response {
  return json(
    {
      error: {
        code: "invalid_args",
        message: "workflow input validation failed",
        issues: issues.map((issue) => ({
          path: Array.isArray(issue.path)
            ? issue.path.map((part) => (typeof part === "number" ? part : String(part)))
            : [],
          message: issue.message ?? "invalid input",
          expected: issue.expected,
        })),
      },
    },
    400,
  );
}

function untrustedCwd(): Response {
  return json({ error: { code: "untrusted_cwd" } }, 400);
}

function serializeErrorRedacted(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const redacted: Record<string, unknown> = { name: error.name, message: error.message };
    const code = (error as { code?: unknown }).code;
    if (code !== undefined) redacted.code = code;
    return redacted;
  }
  return { message: String(error) };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (process.env.PENUMBRA_DEBUG_ERRORS === "1" && error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return serializeErrorRedacted(error);
}

const SYNTHETIC_PROJECT_ID_WARNING =
  "workflow project_id resolved to synthetic git-id; consider adding to projects.yaml";

type WorkflowScopeResolution =
  | { ok: true; project: string; repoRoot: string }
  | { ok: false; response: Response };

function resolveWorkflowScopeOrReject(cwd: string, services: Services): WorkflowScopeResolution {
  const scope = resolveProjectScope({
    cwd,
    registry: services.projectRegistry,
  });
  if (scope.kind === "global") return { ok: false, response: untrustedCwd() };
  if (scope.kind === "registry_unavailable") {
    services.log.error(
      { cwd, resolved_project_id: scope.project_id, repo_root: scope.repo_root },
      "project registry is unavailable while resolving workflow scope",
    );
    return {
      ok: false,
      response: json(
        {
          error: {
            code: "registry_unavailable",
            message: "project registry is unavailable; cannot resolve workflow scope",
          },
        },
        503,
      ),
    };
  }
  if (scope.kind === "no_match") {
    services.log.warn(
      { cwd, resolved_project_id: scope.project_id, repo_root: scope.repo_root },
      SYNTHETIC_PROJECT_ID_WARNING,
    );
  }
  return { ok: true, project: scope.project_id, repoRoot: scope.repo_root };
}

function validateWorkflowArgs(
  entry: { source: "markdown" | "ts"; inputSchema?: unknown },
  rawArgs: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; response: Response } {
  if (entry.source !== "ts" || !isInputSchemaLike(entry.inputSchema)) {
    return { ok: true, args: rawArgs };
  }
  const parsed = entry.inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, response: invalidArgs(parsed.error.issues) };
  }
  return { ok: true, args: parsed.data as Record<string, unknown> };
}

type WorkflowRunsRegistryWithLifecycle = NonNullable<Services["workflowRuns"]> & {
  setPersistenceStatus(
    workflowRunId: string,
    status: "pending" | "persisted" | "persistence_failed",
  ): void;
  setExecutionRecord(
    workflowRunId: string,
    record: {
      status: "running" | "completed" | "failed";
      started_at: number;
      finished_at?: number;
      result?: unknown;
      error?: unknown;
    },
  ): void;
};

function fileTaskDraftObservation(
  services: Services,
  input: {
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
  },
): Promise<void> {
  const machineId = services.machineId.get();
  const maybePayload: Record<string, unknown> = {
    draft_id: services.uuid(),
    prompt: input.prompt,
    affects_projects: input.affects_projects,
    evidence: input.evidence,
    auto_ok: false,
    filed_by_agent: "session-summarize-stop-hook",
    filed_via: "stop_hook",
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
    services.log.error(
      { err: msg, session_id: input.sessionId },
      "session-summarize task draft payload invalid",
    );
    return Promise.resolve();
  }

  const event = {
    event_id: services.uuid(),
    ts: new Date().toISOString(),
    ingest_ts: new Date().toISOString(),
    source: "daemon" as const,
    source_detail: "workflow:session-summarize",
    project_id: input.projectId,
    user_id: "penumbra",
    machine_id: machineId,
    session_id: input.sessionId,
    event_type: "task_draft" as const,
    lane: "unknown" as const,
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: payloadJson,
    payload_summary: input.prompt.slice(0, 240),
    origin: "unknown" as const,
  };
  services.t0Writer.write(event);
  return Promise.resolve();
}

type T0EventRow = {
  source: string;
  event_type: string;
  payload_json: string | null;
};

function buildEventReader(
  services: Services,
  timeCutoff: string,
  maxEvents: number,
): ((sessionId: string) => T0EventRow[]) | undefined {
  // Some callers (tests, transcript-only fallback paths) construct a Services
  // mock without a db handle. Guard the runtime presence even though the type
  // declares db non-optional.
  const db = (services as { db?: Services["db"] }).db;
  if (!db) return undefined;
  return (sessionId: string): T0EventRow[] => {
    const rows = db
      .query(
        `SELECT source, event_type, payload_json
           FROM t0_events
          WHERE session_id = ? AND ts >= ?
            AND (source_detail IS NULL OR source_detail NOT LIKE 'workflow:%')
          ORDER BY ts ASC, event_id ASC
          LIMIT ?`,
      )
      .all(sessionId, timeCutoff, maxEvents + 1) as T0EventRow[];
    if (rows.length > maxEvents) {
      services.log.warn(
        { session_id: sessionId, limit: maxEvents, total: rows.length },
        "session-summarize event scan exceeded cap; truncating",
      );
      return rows.slice(0, maxEvents);
    }
    return rows;
  };
}

async function fileOneStumbleDraft(
  filer: typeof fileTaskDraftObservation,
  services: Services,
  sessionId: string,
  project: string,
  candidate: {
    prompt: string;
    affects_projects: string[];
    evidence: { conv_ids: string[]; commits: string[]; files: string[]; session_id: string };
  },
  provenance: {
    filing_path: string;
    session_id: string;
    extractor_version: string;
    filtered_by: string[];
  },
): Promise<void> {
  try {
    await filer(services, {
      sessionId,
      projectId: project !== "unknown" ? project : null,
      prompt: candidate.prompt,
      affects_projects: candidate.affects_projects,
      evidence: candidate.evidence,
      provenance,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    services.log.error(
      { err: msg, session_id: sessionId },
      "session-summarize stumble filing failed",
    );
  }
}

export async function fileSessionSummarizeStumbles(opts: {
  services: Services;
  sessionId: string;
  project: string;
  extractor?: typeof extractStumblesFromSession;
  filer?: typeof fileTaskDraftObservation;
  eventReader?: ExtractStumblesInput["dispatch_events_query"];
}): Promise<void> {
  const extractor = opts.extractor ?? extractStumblesFromSession;
  const filer = opts.filer ?? fileTaskDraftObservation;
  const now = Date.now();
  const timeCutoff = new Date(now - EVENT_TIME_WINDOW_MS_DEFAULT).toISOString();
  const maxEvents = MAX_EVENTS_SCANNED_DEFAULT;

  const eventReader = opts.eventReader ?? buildEventReader(opts.services, timeCutoff, maxEvents);
  try {
    const candidates = await extractor({
      session_id: opts.sessionId,
      dispatch_events_query: eventReader,
      default_project: opts.project,
      allowed_sources: ["mcp", "transcript", "agentchat"],
      allowed_event_types: ["agent-prompt", "agent-response", "user-prompt"],
      max_events_scanned: maxEvents,
      event_time_window_ms: EVENT_TIME_WINDOW_MS_DEFAULT,
    } as ExtractStumblesInput);

    const capped = candidates.slice(0, MAX_DRAFTS_PER_SESSION);
    if (candidates.length > MAX_DRAFTS_PER_SESSION) {
      const dropped = candidates.slice(MAX_DRAFTS_PER_SESSION);
      const droppedHeuristics = dropped.map((c) => c.prompt.slice(0, 60)).join("; ");
      opts.services.log.warn(
        {
          session_id: opts.sessionId,
          total: candidates.length,
          cap: MAX_DRAFTS_PER_SESSION,
          dropped_count: dropped.length,
          dropped_heuristics: droppedHeuristics,
        },
        "session-summarize stumble drafts exceeded session cap; keeping first N",
      );
    }

    const provenance = {
      filing_path: "stop_hook",
      session_id: opts.sessionId,
      extractor_version: "v1",
      filtered_by: ["source_allowlist", "type_allowlist", "time_window"],
    };

    for (const candidate of capped) {
      await fileOneStumbleDraft(
        filer,
        opts.services,
        opts.sessionId,
        opts.project,
        candidate,
        provenance,
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.services.log.error(
      { err: msg, session_id: opts.sessionId },
      "session-summarize stumble extraction failed",
    );
  }
}

export function workflowsListRoute(_req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) {
    warnRegistryUnavailable(services, "workflows/list");
    return Promise.resolve(json({ workflows: [], registry_unavailable: true }));
  }
  return Promise.resolve(
    json({
      workflows: reg.list().map((spec) => ({
        name: spec.name,
        description: spec.description,
        triggers: spec.triggers,
      })),
      errors: reg.errors,
    }),
  );
}

function buildAgentRegistryAdapter(
  agentRegistry: string[] | null,
): { listAgents: () => { name: string }[] } | undefined {
  if (!agentRegistry) return undefined;
  return { listAgents: (): { name: string }[] => agentRegistry.map((name) => ({ name })) };
}

type WorkflowRunBody = {
  name?: string;
  cwd?: string;
  session_id?: string | null;
  args?: Record<string, unknown>;
  wait?: boolean;
};

async function persistRunResult(
  workflowRuns: WorkflowRunsRegistryWithLifecycle,
  workflowRunId: string,
  start: number,
  result: unknown,
): Promise<void> {
  workflowRuns.setExecutionRecord(workflowRunId, {
    status: "completed",
    started_at: start,
    finished_at: Date.now(),
    result,
  });
  try {
    await workflowRuns.recordResult(workflowRunId, result);
  } catch (err) {
    workflowRuns.setPersistenceStatus(workflowRunId, "persistence_failed");
    throw err;
  }
}

async function persistRunError(
  workflowRuns: WorkflowRunsRegistryWithLifecycle,
  workflowRunId: string,
  start: number,
  error: unknown,
): Promise<void> {
  workflowRuns.setExecutionRecord(workflowRunId, {
    status: "failed",
    started_at: start,
    finished_at: Date.now(),
    error,
  });
  try {
    await workflowRuns.recordError(workflowRunId, error);
  } catch (err) {
    workflowRuns.setPersistenceStatus(workflowRunId, "persistence_failed");
    throw err;
  }
}

type WorkflowRunPrepared = {
  ok: true;
  entry: NonNullable<ReturnType<Registry["getEntry"]>>;
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  body: WorkflowRunBody;
};

function prepareWorkflowRun(
  body: WorkflowRunBody | null,
  reg: Registry,
): WorkflowRunPrepared | { ok: false; response: Response } {
  const name = body?.name;
  if (!name)
    return {
      ok: false,
      response: json({ error: { code: "bad_request", message: "name required" } }, 400),
    };
  const entry = reg.getEntry(name);
  if (!entry)
    return {
      ok: false,
      response: json({ error: { code: "not_found", message: `workflow ${name} not found` } }, 404),
    };
  const rawArgs = body.args ?? {};
  const argsResult = validateWorkflowArgs(entry, rawArgs);
  if (!argsResult.ok) return { ok: false, response: argsResult.response };
  const args = {
    ...argsResult.args,
    ...(body.session_id ? { session_id: body.session_id } : {}),
  };
  return { ok: true, entry, name, args, cwd: body.cwd ?? process.cwd(), body };
}

function attachRunPersistHandlers(
  runPromise: Promise<unknown>,
  workflowRuns: WorkflowRunsRegistryWithLifecycle | undefined,
  workflowRunId: string | null,
  start: number,
  services: Services,
): void {
  void runPromise
    .then(
      async (result: unknown) => {
        if (workflowRunId && workflowRuns) {
          await persistRunResult(workflowRuns, workflowRunId, start, result);
        }
      },
      async (error: unknown) => {
        if (workflowRunId && workflowRuns) {
          await persistRunError(workflowRuns, workflowRunId, start, error);
        }
      },
    )
    .catch((err: unknown) => {
      services.log.error(
        {
          component: "workflow_run_persist",
          workflow_run_id: workflowRunId,
          err: serializeError(err),
        },
        "workflow_run persistence failed",
      );
    });
}

type WorkflowExecOpts = {
  entry: NonNullable<ReturnType<Registry["getEntry"]>>;
  services: Services;
  cwd: string;
  project: string;
  repoRoot: string;
  args: Record<string, unknown>;
  templateCtx: TemplateVarContext;
  agentRegistry: { listAgents: () => { name: string }[] } | undefined;
  workflowRunId: string | null;
  sessionId: string;
  observationCtx?: { sessionId?: string | null; projectId?: string | null };
};

async function composeWorkflowBundle(
  opts: Pick<
    WorkflowExecOpts,
    "entry" | "services" | "cwd" | "project" | "repoRoot" | "agentRegistry" | "templateCtx"
  >,
): Promise<Awaited<ReturnType<typeof composeRecall>>> {
  return await composeRecall({
    db: opts.services.db,
    embedder: opts.services.embedder,
    cwd: opts.cwd,
    repoRoot: opts.repoRoot,
    project: opts.project,
    sources: opts.entry.spec.recall,
    budgetTokens: opts.entry.spec.recall_budget_tokens,
    agentRegistry: opts.agentRegistry,
    templateCtx: opts.templateCtx,
    storageRoot: opts.services.storageRoot,
  });
}

function startWorkflowExecution(
  opts: WorkflowExecOpts,
  bundle: Awaited<ReturnType<typeof composeRecall>>,
): ReturnType<typeof executeWorkflow> {
  const {
    entry,
    services,
    cwd,
    project,
    repoRoot,
    args,
    templateCtx,
    workflowRunId,
    sessionId,
    observationCtx,
  } = opts;
  return executeWorkflow({
    spec: entry.spec,
    bundle,
    fn: entry.fn,
    ctx:
      entry.source === "ts"
        ? buildWorkflowCtx({
            services,
            cwd,
            storageRoot: services.storageRoot,
            project,
            agentchatConfig: asAgentChatConfigLike(services.agentchatConfig),
            args,
            workflowRunId,
            chainStart: (input) =>
              chainStartFromInput(input, services, { applyMaestroBudgetGate: true }),
            chainCancel: async (conversationId) => {
              const response = conversationsCancelRoute(
                new Request(`http://localhost/conversations/${conversationId}/cancel`, {
                  method: "POST",
                }),
                conversationId,
                services,
              );
              if (!response.ok) {
                const body = await response.text();
                throw new Error(`conversation cancel failed (${String(response.status)}): ${body}`);
              }
            },
          })
        : undefined,
    storageRoot: services.storageRoot,
    captureCtx: {
      db: services.db,
      project,
      sessionId,
      userId: "penumbra",
      machineId: process.env.HOSTNAME ?? "unknown",
    },
    repoRoot,
    observationCtx,
    templateCtx,
  });
}

async function waitAndPersist(
  runPromise: Promise<unknown>,
  workflowRuns: WorkflowRunsRegistryWithLifecycle | undefined,
  workflowRunId: string | null,
  start: number,
  services: Services,
): Promise<Response> {
  const result = await runPromise;
  if (workflowRunId && workflowRuns) {
    workflowRuns.setExecutionRecord(workflowRunId, {
      status: "completed",
      started_at: start,
      finished_at: Date.now(),
      result,
    });
    try {
      await workflowRuns.recordResult(workflowRunId, result);
    } catch (err) {
      // Persistence failure must not clobber the completed in-memory record or
      // discard the caller's real result. Mark persistence_failed and fall
      // through — do not rethrow into the outer catch, whose recordError path
      // overwrites the completed record via hydrateRecord's running-row
      // passthrough.
      workflowRuns.setPersistenceStatus(workflowRunId, "persistence_failed");
      services.log.error(
        {
          component: "workflow_run_persist",
          workflow_run_id: workflowRunId,
          err: serializeError(err),
        },
        "workflow_run wait:true persistence failed; returning result to caller",
      );
    }
  }
  return json(result);
}

export async function workflowsRunRoute(req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg)
    return json(
      { error: { code: "no_registry", message: "workflow registry not configured" } },
      500,
    );

  const body = (await req.json().catch(() => null)) as WorkflowRunBody | null;
  const prepared = prepareWorkflowRun(body, reg);
  if (!prepared.ok) return prepared.response;
  const { entry, name, args, cwd } = prepared;

  const scope = resolveWorkflowScopeOrReject(cwd, services);
  if (!scope.ok) return scope.response;
  const { project, repoRoot } = scope;

  const start = Date.now();
  const sessionStart = resolveSessionStart(services.db, prepared.body.session_id ?? null, start);
  const templateCtx: TemplateVarContext = {
    now: (): Date => new Date(),
    project,
    sessionStart,
    tz: process.env.TZ ?? "UTC",
    args,
    repoRoot,
    sessionId: prepared.body.session_id ?? null,
  };
  const agentRegistry = buildAgentRegistryAdapter(services.agentRegistry);
  const workflowRuns = services.workflowRuns as WorkflowRunsRegistryWithLifecycle | undefined;
  const workflowRunId = workflowRuns?.register(name, project) ?? null;
  if (workflowRuns && workflowRunId === null) {
    return json(
      {
        error: { code: "capacity_exhausted", message: "workflow run registry capacity exhausted" },
      },
      503,
    );
  }
  const shouldWait = prepared.body.wait ?? false;
  try {
    const execOpts: WorkflowExecOpts = {
      entry,
      services,
      cwd,
      project,
      repoRoot,
      args,
      templateCtx,
      agentRegistry,
      workflowRunId,
      sessionId: "daemon-direct",
    };
    const bundle = await composeWorkflowBundle(execOpts);
    const runPromise = startWorkflowExecution(execOpts, bundle);
    if (shouldWait) {
      return await waitAndPersist(runPromise, workflowRuns, workflowRunId, start, services);
    }
    attachRunPersistHandlers(runPromise, workflowRuns, workflowRunId, start, services);
    return json({ workflow_run_id: workflowRunId, started_at: start });
  } catch (error) {
    if (workflowRunId && workflowRuns) {
      await workflowRuns.recordError(workflowRunId, error);
    }
    throw error;
  }
}

export async function workflowsStatusRoute(req: Request, services: Services): Promise<Response> {
  const workflowRuns = services.workflowRuns;
  const body = (await req.json().catch(() => null)) as {
    workflow_run_id?: string;
    cwd?: string;
  } | null;
  if (!body?.workflow_run_id)
    return json({ error: { code: "bad_request", message: "workflow_run_id required" } }, 400);
  if (!workflowRuns)
    return json({ error: { code: "not_found", message: "workflow run not found" } }, 404);
  const info = workflowRuns.verify(body.workflow_run_id);
  if (!info) return json({ error: { code: "not_found", message: "workflow run not found" } }, 404);
  const scope = resolveWorkflowScopeOrReject(body.cwd ?? process.cwd(), services);
  if (!scope.ok) return scope.response;
  if (info.project_id !== scope.project) {
    return json({ error: { code: "not_found", message: "workflow run not found" } }, 404);
  }
  const status = await workflowRuns.getStatusLight(body.workflow_run_id);
  if (!status)
    return json({ error: { code: "not_found", message: "workflow run not found" } }, 404);
  return json(status);
}

type WorkflowWaitStatus = Awaited<
  ReturnType<NonNullable<Services["workflowRuns"]>["waitForResult"]>
>;

type WorkflowWaitBody = {
  workflow_run_id?: string;
  timeout_ms?: number;
  cwd?: string;
};

type WorkflowWaitPrepared = {
  ok: true;
  workflowRuns: NonNullable<Services["workflowRuns"]>;
  workflowRunId: string;
  timeoutMs: number;
};

function prepareWaitRequest(
  body: WorkflowWaitBody | null,
  services: Services,
): WorkflowWaitPrepared | { ok: false; response: Response } {
  const workflowRuns = services.workflowRuns;
  if (!body?.workflow_run_id)
    return {
      ok: false,
      response: json({ error: { code: "bad_request", message: "workflow_run_id required" } }, 400),
    };
  if (!workflowRuns)
    return {
      ok: false,
      response: json({ error: { code: "not_found", message: "workflow run not found" } }, 404),
    };
  const info = workflowRuns.verify(body.workflow_run_id);
  if (!info)
    return {
      ok: false,
      response: json({ error: { code: "not_found", message: "workflow run not found" } }, 404),
    };
  const scope = resolveWorkflowScopeOrReject(body.cwd ?? process.cwd(), services);
  if (!scope.ok) return { ok: false, response: scope.response };
  if (info.project_id !== scope.project) {
    return {
      ok: false,
      response: json({ error: { code: "not_found", message: "workflow run not found" } }, 404),
    };
  }
  const timeoutMs = body.timeout_ms ?? 300000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) {
    return {
      ok: false,
      response: json(
        { error: { code: "invalid_args", message: "timeout_ms must be between 1 and 1800000" } },
        400,
      ),
    };
  }
  return { ok: true, workflowRuns, workflowRunId: body.workflow_run_id, timeoutMs };
}

function buildWaitResponseBody(status: NonNullable<WorkflowWaitStatus>): Record<string, unknown> {
  const resultSerialized = status.result === undefined ? undefined : JSON.stringify(status.result);
  const errorSerialized = status.error === undefined ? undefined : JSON.stringify(status.error);
  const resultBytes = resultSerialized === undefined ? 0 : Buffer.byteLength(resultSerialized);
  const errorBytes = errorSerialized === undefined ? 0 : Buffer.byteLength(errorSerialized);
  const response: Record<string, unknown> = {
    status: status.status,
    started_at: status.started_at,
    finished_at: status.finished_at,
    result_bytes: resultBytes,
    error_bytes: errorBytes,
  };
  if (status.result !== undefined) response.result = status.result;
  if (status.error !== undefined) response.error = status.error;
  return response;
}

export async function workflowsWaitRoute(req: Request, services: Services): Promise<Response> {
  const body = (await req.json().catch(() => null)) as WorkflowWaitBody | null;
  const prepared = prepareWaitRequest(body, services);
  if (!prepared.ok) return prepared.response;
  const { workflowRuns, workflowRunId, timeoutMs } = prepared;

  let status: WorkflowWaitStatus;
  try {
    status = await workflowRuns.waitForResult(workflowRunId, timeoutMs);
  } catch (error) {
    if (error instanceof Error && error.message === "waiter_capacity_exhausted") {
      return json(
        { error: { code: "too_many_requests", message: "workflow wait limit reached" } },
        429,
      );
    }
    throw error;
  }
  if (!status) return json({ status: "timeout" });
  return json(buildWaitResponseBody(status));
}

type WorkflowTriggerBody = {
  event?: Trigger;
  cwd?: string;
  args?: Record<string, unknown>;
  hookContext?: { tool_name?: string | null; file_path?: string | null };
  transcript_path?: string | null;
  session_id?: string | null;
  related_session_id?: string | null;
  ref_path?: string | null;
};

function sessionEventKindForTrigger(event: Trigger): SessionEventKind | null {
  if (event.kind !== "lifecycle") return null;
  switch (event.event) {
    case "session-start":
      return "session.start";
    case "pre-compact":
      return "session.pre_compact";
    case "stop":
      return "session.stop";
    case "session-end":
      return "session.end";
    case "post-tool-use":
    case "pre-tool-use":
    case "user-prompt-submit":
      return null;
    default:
      return null;
  }
}

function recordWorkflowTriggerSessionEvent(opts: {
  services: Services;
  body: WorkflowTriggerBody;
  cwd: string;
  project: string;
}): void {
  const event = opts.body.event;
  if (!event) return;
  const kind = sessionEventKindForTrigger(event);
  if (!kind) return;
  try {
    opts.services.sessionEventLog.record({
      session_id: opts.body.session_id ?? null,
      related_session_id: opts.body.related_session_id ?? null,
      project_id: opts.project !== "unknown" ? opts.project : null,
      cwd: opts.cwd,
      transcript_path: opts.body.transcript_path ?? null,
      ref_path: opts.body.ref_path ?? null,
      kind,
      ts: opts.services.clock().toISOString(),
      meta: {
        hookContext: opts.body.hookContext ?? null,
      },
    });
  } catch (err) {
    // Deliberate fail-open: telemetry-write failure must never break hook round-trip.
    opts.services.log.warn({ err, kind }, "session event ingest failed; continuing workflow hook");
  }
}

const SESSION_EVENT_META_MAX_BYTES = 8192;
const SESSION_STAMP_RE =
  /^<!--\s*penumbra:session\s+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*-->/i;

type ContinuationNoteRecall = {
  path: string;
  body: string;
};

function continuationNoteFromBundle(
  bundle: Awaited<ReturnType<typeof composeRecall>>,
): ContinuationNoteRecall | null {
  const raw = bundle.byKey["latest_continuation_note"];
  if (typeof raw !== "object" || raw === null) return null;
  const note = raw as { path?: unknown; body?: unknown };
  if (typeof note.path !== "string" || note.path.length === 0) return null;
  if (typeof note.body !== "string") return null;
  return { path: note.path, body: note.body };
}

function relatedSessionIdFromContinuationNote(body: string): string | null {
  return sessionStampFromBodyPrefix(body);
}

function sessionStampFromBodyPrefix(body: string): string | null {
  const lines = body.split(/\r?\n/, 5);
  for (const line of lines) {
    const match = SESSION_STAMP_RE.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

function truncateUtf8ToBytes(value: string, maxBytes: number): string {
  let end = value.length;
  while (Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes && end > 0) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function bootPickupMeta(
  firstMoves: unknown,
  log?: { warn(fields: Record<string, unknown>, message: string): void },
): Record<string, unknown> | null {
  const meta: Record<string, unknown> = { first_moves: firstMoves ?? null };
  try {
    if (Buffer.byteLength(JSON.stringify(meta), "utf8") <= SESSION_EVENT_META_MAX_BYTES) {
      return meta;
    }
    const firstMovesBlob = JSON.stringify(firstMoves ?? null);
    let budget = SESSION_EVENT_META_MAX_BYTES - 128;
    while (budget > 0) {
      const compact: Record<string, unknown> = {
        first_moves: truncateUtf8ToBytes(firstMovesBlob, budget),
        first_moves_truncated: true,
      };
      if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= SESSION_EVENT_META_MAX_BYTES) {
        return compact;
      }
      budget -= 256;
    }
    return { first_moves: "", first_moves_truncated: true };
  } catch (err) {
    log?.warn(
      { err, kind: "continuity.boot_pickup" },
      "boot pickup session event meta serialization failed; recording without meta",
    );
    return null;
  }
}

function recordBootPickupSessionEvent(opts: {
  services: Services;
  body: WorkflowTriggerBody;
  cwd: string;
  project: string;
  bundle: Awaited<ReturnType<typeof composeRecall>>;
}): boolean {
  if (opts.body.event?.kind !== "lifecycle" || opts.body.event.event !== "session-start") {
    return false;
  }
  const note = continuationNoteFromBundle(opts.bundle);
  if (!note) return false;
  try {
    opts.services.sessionEventLog.record({
      session_id: opts.body.session_id ?? null,
      related_session_id: relatedSessionIdFromContinuationNote(note.body),
      project_id: opts.project !== "unknown" ? opts.project : null,
      cwd: opts.cwd,
      transcript_path: opts.body.transcript_path ?? null,
      ref_path: note.path,
      kind: "continuity.boot_pickup",
      ts: opts.services.clock().toISOString(),
      meta: bootPickupMeta(opts.bundle.byKey["session_first_moves"], opts.services.log),
    });
  } catch (err) {
    opts.services.log.warn(
      { err, kind: "continuity.boot_pickup" },
      "boot pickup session event ingest failed; continuing workflow hook",
    );
    return false;
  }
  return true;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function sessionStampFromSkeletonBody(body: string): string | null {
  return sessionStampFromBodyPrefix(body);
}

function periodKeyFromSkeletonPath(path: string): string | null {
  const match = /^maestro-continuation-(.+)\.skeleton\.md$/.exec(basename(path));
  return match?.[1] ?? null;
}

function readSkeletonStampPrefix(path: string): string {
  const buffer = Buffer.alloc(SKELETON_STAMP_READ_LIMIT_BYTES);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function statIfExists(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

function recordContinuitySessionEvents(opts: {
  services: Services;
  body: WorkflowTriggerBody;
  cwd: string;
  project: string;
  specName: string;
  artifacts: string[];
}): void {
  if (opts.specName !== "session-handoff") return;
  const skeletonArtifact = opts.artifacts.find(
    (artifact) => periodKeyFromSkeletonPath(artifact) !== null,
  );
  if (!skeletonArtifact) return;
  const skeletonPath = resolve(skeletonArtifact);
  const periodKey = periodKeyFromSkeletonPath(skeletonPath);
  if (periodKey === null) return;
  try {
    const skeletonStampPrefix = readSkeletonStampPrefix(skeletonPath);
    const skeletonStat = statSync(skeletonPath);
    opts.services.sessionEventLog.record({
      session_id: opts.body.session_id ?? null,
      related_session_id: null,
      project_id: opts.project !== "unknown" ? opts.project : null,
      cwd: opts.cwd,
      transcript_path: opts.body.transcript_path ?? null,
      ref_path: skeletonPath,
      kind: "continuity.skeleton_generated",
      ts: opts.services.clock().toISOString(),
      meta: {
        session_stamp: sessionStampFromSkeletonBody(skeletonStampPrefix),
        byte_size: skeletonStat.size,
        period_key: periodKey,
      },
    });

    const barePath = skeletonPath.replace(/\.skeleton\.md$/, ".md");
    const bareStat = statIfExists(barePath);
    if (!bareStat || bareStat.mtime.getTime() <= skeletonStat.mtime.getTime()) return;
    opts.services.sessionEventLog.record({
      session_id: opts.body.session_id ?? null,
      related_session_id: null,
      project_id: opts.project !== "unknown" ? opts.project : null,
      cwd: opts.cwd,
      transcript_path: opts.body.transcript_path ?? null,
      ref_path: barePath,
      kind: "continuity.note_superseded",
      ts: opts.services.clock().toISOString(),
      meta: {
        skeleton_path: skeletonPath,
        note_mtime: bareStat.mtime.toISOString(),
        skeleton_mtime: skeletonStat.mtime.toISOString(),
      },
    });
  } catch (err) {
    opts.services.log.warn(
      { err, kind: "continuity.skeleton_generated" },
      "continuity session event ingest failed; continuing workflow hook",
    );
  }
}

function filterMatchedByLifecycle(
  matched: WorkflowSpec[],
  lifecycleEvent: string | undefined,
  toolName: string | undefined,
): WorkflowSpec[] {
  return matched.filter((spec) => {
    for (const trigger of spec.triggers) {
      if (trigger.kind !== "lifecycle") continue;
      if (trigger.event !== lifecycleEvent) continue;
      const filter = trigger.filter;
      if (!filter?.tool_name) return true;
      if (typeof toolName !== "string") return false;
      return filter.tool_name.includes(toolName);
    }
    return false;
  });
}

async function executeMatchedTriggerSpec(opts: {
  spec: WorkflowSpec;
  entry: NonNullable<ReturnType<Registry["getEntry"]>>;
  body: WorkflowTriggerBody;
  sessionIdFromBody: string | null;
  filePathFromBody: string | null;
  cwd: string;
  project: string;
  repoRoot: string;
  services: Services;
  additionalContextParts: string[];
  bootPickupRecorded: { value: boolean };
}): Promise<Response | undefined> {
  const {
    spec,
    entry,
    body,
    sessionIdFromBody,
    filePathFromBody,
    cwd,
    project,
    repoRoot,
    services,
    additionalContextParts,
  } = opts;
  const rawArgs = body.args ?? {};
  const argsResult = validateWorkflowArgs(entry, rawArgs);
  if (!argsResult.ok) return argsResult.response;
  const args = {
    ...argsResult.args,
    ...(sessionIdFromBody ? { session_id: sessionIdFromBody } : {}),
    ...(typeof body.transcript_path === "string" && body.transcript_path.length > 0
      ? { transcript_path: body.transcript_path }
      : {}),
  };
  const start = Date.now();
  const sessionStart = resolveSessionStart(services.db, sessionIdFromBody, start);
  const templateCtx: TemplateVarContext = {
    now: (): Date => new Date(),
    project,
    sessionStart,
    tz: process.env.TZ ?? "UTC",
    cwd,
    repoRoot,
    filePath: filePathFromBody ?? undefined,
    args,
    sessionId: sessionIdFromBody,
  };
  const agentRegistry = buildAgentRegistryAdapter(services.agentRegistry);
  const workflowRuns = services.workflowRuns;
  const workflowRunId = workflowRuns?.register(spec.name, project) ?? null;
  if (workflowRuns && workflowRunId === null) {
    return json(
      {
        error: {
          code: "capacity_exhausted",
          message: "workflow run registry capacity exhausted",
        },
      },
      503,
    );
  }
  try {
    const execOpts: WorkflowExecOpts = {
      entry,
      services,
      cwd,
      project,
      repoRoot,
      args,
      templateCtx,
      agentRegistry,
      workflowRunId,
      sessionId: "hook-trigger",
      observationCtx: {
        sessionId: sessionIdFromBody,
        projectId: project !== "unknown" ? project : null,
      },
    };
    const bundle = await composeWorkflowBundle(execOpts);
    if (!opts.bootPickupRecorded.value) {
      opts.bootPickupRecorded.value = recordBootPickupSessionEvent({
        services,
        body,
        cwd,
        project,
        bundle,
      });
    }
    const result = await startWorkflowExecution(execOpts, bundle);
    recordContinuitySessionEvents({
      services,
      body,
      cwd,
      project,
      specName: spec.name,
      artifacts: result.artifacts,
    });
    if (result.sessionReminder) additionalContextParts.push(result.sessionReminder);
  } finally {
    if (workflowRunId) workflowRuns?.unregister(workflowRunId);
  }
  return undefined;
}

function selectMatchedSpecs(
  reg: Registry,
  triggerEvent: Trigger,
  hookContext: WorkflowTriggerBody["hookContext"],
): WorkflowSpec[] {
  const lifecycleEvent = triggerEvent.kind === "lifecycle" ? triggerEvent.event : undefined;
  const toolName = typeof hookContext?.tool_name === "string" ? hookContext.tool_name : undefined;
  return filterMatchedByLifecycle(
    evaluateTriggerEvent(reg, triggerEvent),
    lifecycleEvent,
    toolName,
  );
}

async function runAllMatchedTriggerSpecs(opts: {
  reg: Registry;
  matched: WorkflowSpec[];
  body: WorkflowTriggerBody;
  sessionIdFromBody: string | null;
  filePathFromBody: string | null;
  cwd: string;
  project: string;
  repoRoot: string;
  services: Services;
  additionalContextParts: string[];
  bootPickupRecorded: { value: boolean };
}): Promise<Response | undefined> {
  for (const spec of opts.matched) {
    const entry = opts.reg.getEntry(spec.name);
    if (!entry) continue;
    const earlyResponse = await executeMatchedTriggerSpec({
      spec,
      entry,
      body: opts.body,
      sessionIdFromBody: opts.sessionIdFromBody,
      filePathFromBody: opts.filePathFromBody,
      cwd: opts.cwd,
      project: opts.project,
      repoRoot: opts.repoRoot,
      services: opts.services,
      additionalContextParts: opts.additionalContextParts,
      bootPickupRecorded: opts.bootPickupRecorded,
    });
    if (earlyResponse) return earlyResponse;
  }
  return undefined;
}

export async function workflowsTriggerRoute(req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) {
    warnRegistryUnavailable(services, "workflows/trigger");
    return json({ matched: [], additionalContext: null, registry_unavailable: true });
  }
  const body = (await req.json().catch(() => null)) as WorkflowTriggerBody | null;
  const sessionIdFromBody = body?.session_id ?? null;
  const filePathFromBody =
    typeof body?.hookContext?.file_path === "string" ? body.hookContext.file_path : null;
  if (!body?.event) return json({ error: { code: "bad_request", message: "event required" } }, 400);

  const cwd = body.cwd ?? process.cwd();
  const scope = resolveWorkflowScopeOrReject(cwd, services);
  if (!scope.ok) return scope.response;
  const { project, repoRoot } = scope;
  recordWorkflowTriggerSessionEvent({ services, body, cwd, project });

  const matched = selectMatchedSpecs(reg, body.event, body.hookContext);

  const additionalContextParts: string[] = [];
  const bootPickupRecorded = { value: false };
  const earlyResponse = await runAllMatchedTriggerSpecs({
    reg,
    matched,
    body,
    sessionIdFromBody,
    filePathFromBody,
    cwd,
    project,
    repoRoot,
    services,
    additionalContextParts,
    bootPickupRecorded,
  });
  if (earlyResponse) return earlyResponse;

  if (matched.some((spec) => spec.name === "session-summarize") && sessionIdFromBody) {
    await fileSessionSummarizeStumbles({
      services,
      sessionId: sessionIdFromBody,
      project,
    });
  }

  const additionalContext = additionalContextParts.length
    ? additionalContextParts.join("\n\n")
    : null;
  return json({ matched: matched.map((s) => s.name), additionalContext });
}

type WorkflowStatsRow = { workflow_name: string; [key: string]: unknown };
type WorkflowOutcomeRow = { ts: string; event_type: string; payload_json: string | null };

export function workflowsHistoryRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  if (!name)
    return Promise.resolve(json({ error: { code: "bad_request", message: "name required" } }, 400));
  const db = services.db;
  const stats =
    (db.query("SELECT * FROM workflow_stats WHERE workflow_name = ?").get(name) as
      | WorkflowStatsRow
      | undefined) ?? null;
  const recent = db
    .query(
      `SELECT ts, event_type, payload_json FROM t0_events WHERE event_type = 'workflow.outcome' AND json_extract(payload_json, '$.workflow_name') = ? ORDER BY ts DESC LIMIT 20`,
    )
    .all(name) as WorkflowOutcomeRow[];
  return Promise.resolve(json({ stats, recent }));
}

export async function workflowsSuggestRoute(req: Request, services: Services): Promise<Response> {
  const reg = getRegistry(services);
  if (!reg) {
    warnRegistryUnavailable(services, "workflows/suggest");
    return json({
      suggestions: [],
      metrics: {
        "queue-idle-min": 0,
        "time-since-last-handoff-min": 0,
        "pending-handoffs": 0,
        "commits-since-last-handoff": 0,
      },
      registry_unavailable: true,
    });
  }
  const body = (await req.json().catch(() => ({}))) as { now?: string };
  const now = body.now ? new Date(body.now) : new Date();
  const metrics = computeStateMetrics({ db: services.db, now: (): Date => now });
  const suggestions = evaluateStateThresholds(reg, metrics).map((s) => ({
    name: s.name,
    description: s.description,
    triggers: s.triggers,
  }));
  return json({ suggestions, metrics });
}
