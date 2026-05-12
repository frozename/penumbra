import type { Services } from '@penumbra/core';
import { z } from 'zod';

import { json } from './_helpers.js';
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

const approvedSessions = new Map<string, Set<string>>();

function isApproved(handoffId: string, sessionId: string): boolean {
  return approvedSessions.get(handoffId)?.has(sessionId) ?? false;
}

function markApproved(handoffId: string, sessionId: string): void {
  if (!approvedSessions.has(handoffId)) approvedSessions.set(handoffId, new Set());
  approvedSessions.get(handoffId)!.add(sessionId);
}

function clearApproved(handoffId: string, sessionId?: string): void {
  if (!sessionId) {
    approvedSessions.delete(handoffId);
    return;
  }

  const sessions = approvedSessions.get(handoffId);
  sessions?.delete(sessionId);
  if (sessions && sessions.size === 0) approvedSessions.delete(handoffId);
}

async function requestPermission(services: Services, input: {
  handoffId: string;
  agentName: string;
  toolName: 'shell_run' | 'shell_run.dangerous';
  context: Record<string, unknown>;
}): Promise<'approve' | 'reject'> {
  const agentchatConfig = (services as any).agentchatConfig;
  const permissionService = (services as any).permissionService;
  const cfg = agentchatConfig?.agents?.find((agent: any) => agent.name === input.agentName);
  if (input.toolName === 'shell_run' && cfg?.auto_approve_to?.includes('shell_run')) {
    return 'approve';
  }
  if (!permissionService?.requestPermission) {
    return 'reject';
  }

  const decision = await permissionService.requestPermission({
    parent_handoff_id: input.handoffId,
    agent_name: input.agentName,
    tool_name: input.toolName,
    context: input.context,
  });
  return decision.approved ? 'approve' : 'reject';
}

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function recordShellEvent(services: Services, event: {
  handoff_id: string;
  kind: 'shell.session.open' | 'shell.run' | 'shell.session.close';
  meta: Record<string, unknown>;
}): void {
  services.dispatchEventLog.record({
    handoff_id: event.handoff_id,
    worker_id: null,
    source: 'daemon',
    kind: event.kind,
    ts: new Date().toISOString(),
    meta: event.meta,
  });
}

export async function shellRunRoute(req: Request, services: Services): Promise<Response> {
  const shellSessionPool = (services as any).shellSessionPool;
  const shellConfig = (services as any).shellConfig;
  if (!shellSessionPool) {
    return json({ error: { code: 'shell_disabled' } }, 503);
  }

  const body = await safeJson(req);
  if (body === null) {
    return json({ error: { code: 'invalid_json' } }, 400);
  }

  const parsed = ShellRunInputSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  }

  const { handoff_id, agent_name, session_id, command, cwd, env, pty, stdin } = parsed.data;
  let resolvedSessionId = session_id;
  const isNewSession = !resolvedSessionId;

  if (isNewSession) {
    try {
      const created = await shellSessionPool.createSession({
        handoffId: handoff_id,
        cwd: cwd ?? services.worktreeManager?.getWorktree?.(handoff_id)?.path ?? process.cwd(),
        env: env ?? {},
        pty: pty ?? false,
        agentName: agent_name,
      });
      resolvedSessionId = created.sessionId;
      recordShellEvent(services, {
        handoff_id,
        kind: 'shell.session.open',
        meta: {
          session_id: resolvedSessionId,
          cwd: cwd ?? null,
          pty: pty ?? false,
        },
      });
    } catch (error) {
      if (String(error).includes('max sessions')) {
        return json({ error: { code: 'max_sessions_exceeded' } }, 429);
      }
      return json({ error: { code: 'session_create_failed' } }, 500);
    }
  }

  if (!isApproved(handoff_id, resolvedSessionId!)) {
    const decision = await requestPermission(services, {
      handoffId: handoff_id,
      agentName: agent_name,
      toolName: 'shell_run',
      context: {
        session_id: resolvedSessionId,
        cwd,
        pty: pty ?? false,
        initial_command: command.slice(0, 200),
      },
    });
    if (decision === 'reject') {
      await shellSessionPool.closeSession({
        handoffId: handoff_id,
        sessionId: resolvedSessionId!,
      });
      clearApproved(handoff_id, resolvedSessionId!);
      return json({
        session_id: resolvedSessionId,
        exit_code: -2,
        stdout: '',
        stderr: 'permission denied: shell_run',
        truncated: false,
      });
    }
    markApproved(handoff_id, resolvedSessionId!);
  }

  const dangerousPatterns = shellConfig?.dangerousCommandsForAgent?.(agent_name) ?? [];
  const normalizedCommand = command.replace(/\s+/g, ' ');
  const matchedPatterns = dangerousPatterns.filter((pattern: string) => new RegExp(pattern).test(normalizedCommand));
  if (matchedPatterns.length > 0) {
    const decision = await requestPermission(services, {
      handoffId: handoff_id,
      agentName: agent_name,
      toolName: 'shell_run.dangerous',
      context: {
        session_id: resolvedSessionId,
        command: command.slice(0, 1024),
        matched_patterns: matchedPatterns,
      },
    });
    if (decision === 'reject') {
      return json({
        session_id: resolvedSessionId,
        exit_code: -2,
        stdout: '',
        stderr: `permission denied: shell_run.dangerous (matched ${matchedPatterns.join(', ')})`,
        truncated: false,
      });
    }
  }

  const startedAt = Date.now();
  const result = await shellSessionPool.runCommand({
    handoffId: handoff_id,
    sessionId: resolvedSessionId,
    command,
    stdin,
    agentName: agent_name,
  });
  const response = { session_id: resolvedSessionId, ...result };
  if (result.exit_code !== -2) {
    recordShellEvent(services, {
      handoff_id,
      kind: 'shell.run',
      meta: {
        session_id: resolvedSessionId,
        command: command.slice(0, 1024),
        exit_code: result.exit_code,
        duration_ms: Date.now() - startedAt,
        truncated: result.truncated,
      },
    });
  }
  return json(response);
}

export async function shellCloseRoute(req: Request, services: Services): Promise<Response> {
  const shellSessionPool = (services as any).shellSessionPool;
  if (!shellSessionPool) {
    return json({ error: { code: 'shell_disabled' } }, 503);
  }

  const body = await safeJson(req);
  if (body === null) {
    return json({ error: { code: 'invalid_json' } }, 400);
  }

  const parsed = ShellCloseInputSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  }

  const result = await shellSessionPool.closeSession({
    handoffId: parsed.data.handoff_id,
    sessionId: parsed.data.session_id,
  });
  recordShellEvent(services, {
    handoff_id: parsed.data.handoff_id,
    kind: 'shell.session.close',
    meta: { session_id: parsed.data.session_id, reason: 'explicit' },
  });
  clearApproved(parsed.data.handoff_id, parsed.data.session_id);
  return json(result);
}

export async function shellListRoute(req: Request, services: Services): Promise<Response> {
  const shellSessionPool = (services as any).shellSessionPool;
  if (!shellSessionPool) {
    return json({ error: { code: 'shell_disabled' } }, 503);
  }

  const handoffId = new URL(req.url).searchParams.get('handoff_id');
  if (!handoffId) {
    return json({ error: { code: 'missing_handoff_id' } }, 400);
  }

  return json({ sessions: shellSessionPool.listSessions(handoffId) });
}
