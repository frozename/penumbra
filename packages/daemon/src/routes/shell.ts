import type { Services } from '@penumbra/core';
import { z } from 'zod';

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

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function shellRunRoute(req: Request, services: Services): Promise<Response> {
  const shellSessionPool = (services as any).shellSessionPool;
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

  if (!resolvedSessionId) {
    try {
      const created = await shellSessionPool.createSession({
        handoffId: handoff_id,
        cwd: cwd ?? services.worktreeManager?.getWorktree?.(handoff_id)?.path ?? process.cwd(),
        env: env ?? {},
        pty: pty ?? false,
        agentName: agent_name,
      });
      resolvedSessionId = created.sessionId;
    } catch (error) {
      if (String(error).includes('max sessions')) {
        return json({ error: { code: 'max_sessions_exceeded' } }, 429);
      }
      return json({ error: { code: 'session_create_failed' } }, 500);
    }
  }

  const result = await shellSessionPool.runCommand({
    handoffId: handoff_id,
    sessionId: resolvedSessionId,
    command,
    stdin,
    agentName: agent_name,
  });
  return json({ session_id: resolvedSessionId, ...result });
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
