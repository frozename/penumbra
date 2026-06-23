import type { HandoffRow, Services } from "@penumbra/core";

import { z } from "zod";

import type { DaemonServices } from "../serve.js";
import type {
  InProcessPermissionDecision,
  InProcessPermissionRequestInput,
} from "../services/in-process-permission-service.js";

import { json } from "./_helpers.js";
import { checkWorkerOwnership } from "./fs.js";

const ShellRunInputSchema = z.object({
  handoff_id: z.string().min(1),
  agent_name: z.string().min(1),
  session_id: z.string().min(1).optional(),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  pty: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
  stdin: z.string().optional(),
});

const ShellCloseInputSchema = z.object({
  handoff_id: z.string().min(1),
  session_id: z.string().min(1),
});

const ShellAgentchatConfigSchema = z.looseObject({
  agents: z
    .array(
      z.looseObject({
        auto_approve_to: z.unknown().optional(),
        name: z.string(),
      }),
    )
    .optional(),
});

type ShellRunInput = z.infer<typeof ShellRunInputSchema>;
type ShellSessionPool = NonNullable<DaemonServices["shellSessionPool"]>;
type ShellConfig = NonNullable<DaemonServices["shellConfig"]>;
type PermissionService = {
  requestPermission(input: InProcessPermissionRequestInput): Promise<InProcessPermissionDecision>;
};
type ShellDaemonServices = DaemonServices & {
  permissionService?: PermissionService;
};

const TERMINAL_STATUSES = new Set<HandoffRow["status"]>([
  "completed",
  "failed",
  "rejected",
  "expired",
]);

const approvedSessions = new Map<string, Set<string>>();

function isApproved(handoffId: string, sessionId: string): boolean {
  return approvedSessions.get(handoffId)?.has(sessionId) ?? false;
}

function markApproved(handoffId: string, sessionId: string): void {
  let sessions = approvedSessions.get(handoffId);
  if (!sessions) {
    sessions = new Set();
    approvedSessions.set(handoffId, sessions);
  }
  sessions.add(sessionId);
}

function clearApproved(handoffId: string, sessionId?: string): void {
  if (!sessionId) {
    approvedSessions.delete(handoffId);
    return;
  }

  const sessions = approvedSessions.get(handoffId);
  sessions?.delete(sessionId);
  if (sessions?.size === 0) approvedSessions.delete(handoffId);
}

function autoApproveTargetsForAgent(agentchatConfig: unknown, agentName: string): unknown {
  const parsed = ShellAgentchatConfigSchema.safeParse(agentchatConfig);
  if (!parsed.success) {
    return undefined;
  }

  const cfg = parsed.data.agents?.find((agent) => agent.name === agentName);
  return cfg?.auto_approve_to;
}

async function requestPermission(
  services: DaemonServices,
  input: {
    handoffId: string;
    agentName: string;
    toolName: "shell_run" | "shell_run.dangerous";
    context: Record<string, unknown>;
  },
): Promise<"approve" | "reject"> {
  const shellServices = services as ShellDaemonServices;
  const permissionService = shellServices.permissionService;
  const autoApproveTo = autoApproveTargetsForAgent(services.agentchatConfig, input.agentName);
  if (
    input.toolName === "shell_run" &&
    Array.isArray(autoApproveTo) &&
    autoApproveTo.includes("shell_run")
  ) {
    return "approve";
  }
  if (!permissionService) {
    return "reject";
  }

  const decision = await permissionService.requestPermission({
    parent_handoff_id: input.handoffId,
    agent_name: input.agentName,
    tool_name: input.toolName,
    context: input.context,
  });
  return decision.approved ? "approve" : "reject";
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function shellRuntime(services: DaemonServices):
  | Response
  | {
      shellConfig: ShellConfig;
      shellSessionPool: ShellSessionPool;
    } {
  const shellSessionPool = services.shellSessionPool;
  const shellConfig = services.shellConfig;

  if (!shellSessionPool) {
    return json({ error: { code: "shell_disabled" } }, 503);
  }

  if (!shellConfig) {
    return json(
      {
        error: {
          code: "shell_config_unavailable",
          message: "service temporarily unavailable",
        },
      },
      503,
    );
  }

  return { shellConfig, shellSessionPool };
}

function runnableHandoff(
  req: Request,
  services: DaemonServices,
  input: Pick<ShellRunInput, "agent_name" | "handoff_id">,
): HandoffRow | Response {
  const handoff = services.handoffReader.get(input.handoff_id);
  if (!handoff) {
    return json({ error: { code: "handoff_not_found" } }, 404);
  }

  const ownershipDenied = checkWorkerOwnership(req, handoff.worker_id);
  if (ownershipDenied !== null) return ownershipDenied;

  if (TERMINAL_STATUSES.has(handoff.status)) {
    return json({ error: { code: "handoff_terminal", status: handoff.status } }, 409);
  }

  if (handoff.to_agent !== input.agent_name) {
    return json({ error: { code: "agent_mismatch", expected: handoff.to_agent } }, 403);
  }

  return handoff;
}

async function resolveShellSession(
  services: DaemonServices,
  shellSessionPool: ShellSessionPool,
  handoff: HandoffRow,
  input: ShellRunInput,
): Promise<{ isNewSession: boolean; sessionId: string } | Response> {
  if (input.session_id) {
    return { isNewSession: false, sessionId: input.session_id };
  }

  try {
    const worktree = services.worktreeManager.getWorktree(
      input.handoff_id,
      handoff.project_id ?? undefined,
    );
    const created = await shellSessionPool.createSession({
      handoffId: input.handoff_id,
      cwd: input.cwd ?? worktree?.path ?? process.cwd(),
      env: input.env ?? {},
      pty: input.pty ?? false,
      agentName: input.agent_name,
    });
    recordShellEvent(services, {
      handoff_id: input.handoff_id,
      kind: "shell.session.open",
      meta: {
        session_id: created.sessionId,
        cwd: input.cwd ?? null,
        pty: input.pty ?? false,
      },
    });
    return { isNewSession: true, sessionId: created.sessionId };
  } catch (error) {
    if (String(error).includes("max sessions")) {
      return json({ error: { code: "max_sessions_exceeded" } }, 429);
    }
    return json({ error: { code: "session_create_failed" } }, 500);
  }
}

async function ensureShellPermission(
  services: DaemonServices,
  shellSessionPool: ShellSessionPool,
  input: ShellRunInput,
  sessionId: string,
): Promise<Response | null> {
  if (isApproved(input.handoff_id, sessionId)) {
    return null;
  }

  const decision = await requestPermission(services, {
    handoffId: input.handoff_id,
    agentName: input.agent_name,
    toolName: "shell_run",
    context: {
      session_id: sessionId,
      cwd: input.cwd,
      pty: input.pty ?? false,
      initial_command: input.command.slice(0, 200),
    },
  });
  if (decision === "approve") {
    markApproved(input.handoff_id, sessionId);
    return null;
  }

  await shellSessionPool.closeSession({
    handoffId: input.handoff_id,
    sessionId,
  });
  clearApproved(input.handoff_id, sessionId);
  return json({
    session_id: sessionId,
    exit_code: -2,
    stdout: "",
    stderr: "permission denied: shell_run",
    truncated: false,
  });
}

function matchedDangerousPatterns(
  shellConfig: ShellConfig,
  agentName: string,
  command: string,
): string[] {
  const dangerousPatterns = shellConfig.dangerousCommandsForAgent(agentName);
  const normalizedCommand = command.replaceAll(/\s+/g, " ");
  return dangerousPatterns.filter((pattern) => {
    try {
      return new RegExp(pattern).test(normalizedCommand);
    } catch (err) {
      console.warn(`[shell-run] Malformed dangerous command pattern "${pattern}":`, err);
      return true;
    }
  });
}

async function ensureDangerousCommandPermission(
  services: DaemonServices,
  shellConfig: ShellConfig,
  input: ShellRunInput,
  sessionId: string,
): Promise<Response | null> {
  const matchedPatterns = matchedDangerousPatterns(shellConfig, input.agent_name, input.command);
  if (matchedPatterns.length === 0) {
    return null;
  }

  const decision = await requestPermission(services, {
    handoffId: input.handoff_id,
    agentName: input.agent_name,
    toolName: "shell_run.dangerous",
    context: {
      session_id: sessionId,
      command: input.command.slice(0, 1024),
      matched_patterns: matchedPatterns,
    },
  });
  if (decision === "approve") {
    return null;
  }

  return json({
    session_id: sessionId,
    exit_code: -2,
    stdout: "",
    stderr: `permission denied: shell_run.dangerous (matched ${matchedPatterns.join(", ")})`,
    truncated: false,
  });
}

function recordShellEvent(
  services: DaemonServices,
  event: {
    handoff_id: string;
    kind: "shell.session.open" | "shell.run" | "shell.session.close";
    meta: Record<string, unknown>;
  },
): void {
  services.dispatchEventLog.record({
    handoff_id: event.handoff_id,
    worker_id: null,
    source: "daemon",
    kind: event.kind,
    ts: new Date().toISOString(),
    meta: event.meta,
  });
}

export async function shellRunRoute(req: Request, _services: Services): Promise<Response> {
  const services = _services as DaemonServices;
  const runtime = shellRuntime(services);
  if (runtime instanceof Response) return runtime;

  const body = await safeJson(req);
  if (body === null) {
    return json({ error: { code: "invalid_json" } }, 400);
  }

  const parsed = ShellRunInputSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }

  const handoff = runnableHandoff(req, services, parsed.data);
  if (handoff instanceof Response) return handoff;

  const session = await resolveShellSession(
    services,
    runtime.shellSessionPool,
    handoff,
    parsed.data,
  );
  if (session instanceof Response) return session;

  const permissionDenied = await ensureShellPermission(
    services,
    runtime.shellSessionPool,
    parsed.data,
    session.sessionId,
  );
  if (permissionDenied !== null) return permissionDenied;

  const dangerousPermissionDenied = await ensureDangerousCommandPermission(
    services,
    runtime.shellConfig,
    parsed.data,
    session.sessionId,
  );
  if (dangerousPermissionDenied !== null) return dangerousPermissionDenied;

  const startedAt = Date.now();
  const result = await runtime.shellSessionPool.runCommand({
    handoffId: parsed.data.handoff_id,
    sessionId: session.sessionId,
    command: parsed.data.command,
    stdin: parsed.data.stdin,
    agentName: parsed.data.agent_name,
  });
  const response = { session_id: session.sessionId, ...result };
  if (result.exit_code !== -2) {
    recordShellEvent(services, {
      handoff_id: parsed.data.handoff_id,
      kind: "shell.run",
      meta: {
        session_id: session.sessionId,
        command: parsed.data.command.slice(0, 1024),
        exit_code: result.exit_code,
        duration_ms: Date.now() - startedAt,
        truncated: result.truncated,
      },
    });
  }
  return json(response);
}

export async function shellCloseRoute(req: Request, _services: Services): Promise<Response> {
  const services = _services as DaemonServices;
  const shellSessionPool = services.shellSessionPool;
  if (!shellSessionPool) {
    return json({ error: { code: "shell_disabled" } }, 503);
  }

  const body = await safeJson(req);
  if (body === null) {
    return json({ error: { code: "invalid_json" } }, 400);
  }

  const parsed = ShellCloseInputSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: { code: "invalid_params", issues: parsed.error.issues } }, 400);
  }

  const closeHandoff = services.handoffReader.get(parsed.data.handoff_id);
  if (!closeHandoff) {
    return json({ error: { code: "handoff_not_found" } }, 404);
  }
  const closeOwnershipDenied = checkWorkerOwnership(req, closeHandoff.worker_id);
  if (closeOwnershipDenied !== null) return closeOwnershipDenied;
  if (TERMINAL_STATUSES.has(closeHandoff.status)) {
    return json({ error: { code: "handoff_terminal", status: closeHandoff.status } }, 409);
  }

  const result = await shellSessionPool.closeSession({
    handoffId: parsed.data.handoff_id,
    sessionId: parsed.data.session_id,
  });
  recordShellEvent(services, {
    handoff_id: parsed.data.handoff_id,
    kind: "shell.session.close",
    meta: { session_id: parsed.data.session_id, reason: "explicit" },
  });
  clearApproved(parsed.data.handoff_id, parsed.data.session_id);
  return json(result);
}

export function shellListRoute(req: Request, _services: Services): Response {
  const services = _services as DaemonServices;
  const shellSessionPool = services.shellSessionPool;
  if (!shellSessionPool) {
    return json({ error: { code: "shell_disabled" } }, 503);
  }

  const handoffId = new URL(req.url).searchParams.get("handoff_id");
  if (!handoffId) {
    return json({ error: { code: "missing_handoff_id" } }, 400);
  }

  const listHandoff = services.handoffReader.get(handoffId);
  if (!listHandoff) {
    return json({ error: { code: "handoff_not_found" } }, 404);
  }
  const listOwnershipDenied = checkWorkerOwnership(req, listHandoff.worker_id);
  if (listOwnershipDenied !== null) return listOwnershipDenied;

  return json({ sessions: shellSessionPool.listSessions(handoffId) });
}
