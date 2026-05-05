import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { T0EventInput } from '@penumbra/core';
import { resolveProjectId } from '@penumbra/core';

export interface MapOpts {
  project: string | null;
  sessionId: string | null;
}

export interface RunHookOpts extends MapOpts {
  storageRoot: string;
  rawEvent: string;
}

interface ClaudeCodeHookEvent {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const port = readFileSync(join(storageRoot, 'port'), 'utf8').trim();
  const token = readFileSync(join(storageRoot, 'token'), 'utf8').trim();
  if (!port || Number.isNaN(Number(port))) {
    throw new Error(`penumbra hook: invalid daemon port in ${join(storageRoot, 'port')}`);
  }
  if (!token) {
    throw new Error(`penumbra hook: empty daemon token in ${join(storageRoot, 'token')}`);
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export type LifecycleEvent =
  | 'session-start'
  | 'pre-compact'
  | 'stop'
  | 'user-prompt-submit'
  | 'pre-tool-use'
  | 'post-tool-use';
export type LifecycleHookContext = {
  tool_name?: string | null;
  file_path?: string | null;
};
export type LifecycleForwardFn = (event: {
  kind: 'lifecycle';
  event: LifecycleEvent;
  hookContext?: LifecycleHookContext;
}) => Promise<void>;

export async function runLifecycleForward(opts: {
  event: LifecycleEvent;
  cwd: string;
  forwardFn: LifecycleForwardFn;
  hookContext?: LifecycleHookContext;
}): Promise<void> {
  await opts.forwardFn({ kind: 'lifecycle', event: opts.event, hookContext: opts.hookContext });
}

function lifecycleToHookEventName(event: LifecycleEvent): string {
  switch (event) {
    case 'session-start':
      return 'SessionStart';
    case 'pre-compact':
      return 'PreCompact';
    case 'stop':
      return 'Stop';
    case 'user-prompt-submit':
      return 'UserPromptSubmit';
    case 'pre-tool-use':
      return 'PreToolUse';
    case 'post-tool-use':
      return 'PostToolUse';
  }
}

export function claudeCodeEventToLifecycle(name: string | undefined | null): LifecycleEvent | null {
  switch (name) {
    case 'SessionStart':
      return 'session-start';
    case 'PreCompact':
      return 'pre-compact';
    case 'Stop':
      return 'stop';
    case 'UserPromptSubmit':
      return 'user-prompt-submit';
    case 'PreToolUse':
      return 'pre-tool-use';
    case 'PostToolUse':
      return 'post-tool-use';
    default:
      return null;
  }
}

export async function defaultLifecycleForwardFn(
  storageRoot: string,
  cwd: string,
  sessionContext?: { sessionId?: string | null; projectId?: string | null },
): Promise<LifecycleForwardFn> {
  const daemon = resolveDaemon(storageRoot);
  return async (event) => {
    try {
      const res = await fetch(`${daemon.baseUrl}/workflows/trigger`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          event,
          cwd,
          hookContext: {
            tool_name: event.hookContext?.tool_name ?? null,
            file_path: event.hookContext?.file_path ?? null,
          },
          session_id: sessionContext?.sessionId ?? null,
        }),
      });
      const data = (await res.json().catch(() => null)) as { additionalContext?: unknown } | null;
      const additionalContext = data?.additionalContext;
      if (typeof additionalContext === 'string' && additionalContext.length > 0) {
        const envelope = {
          hookSpecificOutput: {
            hookEventName: lifecycleToHookEventName(event.event),
            additionalContext,
          },
        };
        process.stdout.write(JSON.stringify(envelope) + '\n');
      }
    } catch {
      // Best-effort: never fail the hook if lifecycle forwarding fails.
    }
  };
}

export function mapClaudeCodeEvent(raw: unknown, opts: MapOpts): T0EventInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw as ClaudeCodeHookEvent;
  const ts = new Date().toISOString();
  // Precedence: explicit --project flag > derived-from-cwd > null. Derivation
  // uses the same resolver other penumbra surfaces use (git remote hash + relpath,
  // .penumbra-project marker, else null), so a hook event from /repos/foo gets
  // the same project_id as a memory observation written from inside that repo.
  let projectId: string | null = opts.project ?? null;
  if (!projectId && typeof ev.cwd === 'string' && ev.cwd.length > 0) {
    try {
      projectId = resolveProjectId({ cwd: ev.cwd }).project_id;
    } catch {
      // Best-effort: if git isn't available or cwd is gone, fall through to null.
    }
  }
  const sessionId = opts.sessionId ?? ev.session_id ?? null;

  // Skip Pre/PostToolUse capture for the memory_recall MCP call itself. Both
  // the call (event=PreToolUse) and its response body (event=PostToolUse)
  // contain the verbatim query terms, which would forever rank as top matches
  // for any future recall on the same terms — recall would surface its own
  // history before any real content. Audit value of these rows is near-zero
  // since the recall call is recoverable from the conversation transcript.
  const toolNameForFilter = typeof ev.tool_name === 'string' ? ev.tool_name : '';
  if (
    (ev.hook_event_name === 'PreToolUse' || ev.hook_event_name === 'PostToolUse') &&
    toolNameForFilter === 'mcp__penumbra__memory_recall'
  ) {
    return null;
  }

  switch (ev.hook_event_name) {
    case 'UserPromptSubmit': {
      const prompt = typeof ev.prompt === 'string' ? ev.prompt : '';
      return {
        ts,
        source: 'claude-code',
        source_detail: 'user-prompt',
        project_id: projectId,
        session_id: sessionId,
        event_type: 'agent-prompt',
        lane: 'cli-subscription',
        payload_json: { prompt, cwd: ev.cwd ?? null },
        payload_summary: prompt.length > 0 ? prompt.slice(0, 240) : null,
        user_id: 'claude-code',
        machine_id: 'local',
      };
    }
    case 'PreToolUse': {
      const toolName = typeof ev.tool_name === 'string' ? ev.tool_name : 'unknown';
      const input = ev.tool_input ?? null;
      const summary = `${toolName}(${JSON.stringify(input ?? {}).slice(0, 200)})`;
      return {
        ts,
        source: 'claude-code',
        source_detail: `tool:${toolName}`,
        project_id: projectId,
        session_id: sessionId,
        event_type: 'agent-tool-use',
        lane: 'cli-subscription',
        payload_json: { tool: toolName, input },
        payload_summary: summary,
        user_id: 'claude-code',
        machine_id: 'local',
      };
    }
    case 'PostToolUse': {
      const toolName = typeof ev.tool_name === 'string' ? ev.tool_name : 'unknown';
      const out = ev.tool_response ?? null;
      const summary = `${toolName} -> ${JSON.stringify(out ?? {}).slice(0, 200)}`;
      return {
        ts,
        source: 'claude-code',
        source_detail: `tool-response:${toolName}`,
        project_id: projectId,
        session_id: sessionId,
        event_type: 'agent-response',
        lane: 'cli-subscription',
        payload_json: { tool: toolName, response: out },
        payload_summary: summary,
        user_id: 'claude-code',
        machine_id: 'local',
      };
    }
    case 'SessionStart':
    case 'PreCompact':
    case 'Stop': {
      return null;
    }
    default:
      return null;
  }
}

export async function runHook(opts: RunHookOpts): Promise<number> {
  const portPath = join(opts.storageRoot, 'port');
  const tokenPath = join(opts.storageRoot, 'token');
  if (!existsSync(portPath) || !existsSync(tokenPath)) {
    // Daemon not running. Hooks are best-effort — never block Claude Code.
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.rawEvent);
  } catch {
    return 0;
  }

  const ev = parsed as ClaudeCodeHookEvent | null;
  const sessionId = opts.sessionId ?? ev?.session_id ?? null;
  const cwdForResolve = typeof ev?.cwd === 'string' && ev.cwd.length > 0 ? ev.cwd : process.cwd();
  let projectIdForTouch: string | null = opts.project ?? null;
  if (!projectIdForTouch) {
    try {
      projectIdForTouch = resolveProjectId({ cwd: cwdForResolve }).project_id;
    } catch {
      projectIdForTouch = null;
    }
  }
  if (sessionId) {
    try {
      const daemon = resolveDaemon(opts.storageRoot);
      await fetch(`${daemon.baseUrl}/sessions/touch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          project_id: projectIdForTouch,
        }),
      });
    } catch {
      // Best-effort: never fail the hook if /sessions/touch fails.
    }
  }

  const lifecycleEvent = claudeCodeEventToLifecycle(ev?.hook_event_name);
  if (lifecycleEvent) {
    const cwd = cwdForResolve;
    const toolNameForCtx = typeof ev?.tool_name === 'string' ? ev.tool_name : null;
    const toolInputForCtx = ev?.tool_input as { file_path?: unknown } | null | undefined;
    const filePathForCtx =
      toolInputForCtx && typeof toolInputForCtx.file_path === 'string'
        ? toolInputForCtx.file_path
        : null;
    try {
      const forwardFn = await defaultLifecycleForwardFn(opts.storageRoot, cwd, {
        sessionId,
        projectId: projectIdForTouch,
      });
      await runLifecycleForward({
        event: lifecycleEvent,
        cwd,
        forwardFn,
        hookContext: { tool_name: toolNameForCtx, file_path: filePathForCtx },
      });
    } catch {
      // Best-effort: never fail the hook if lifecycle forwarding fails.
    }
    if (
      lifecycleEvent === 'session-start' ||
      lifecycleEvent === 'pre-compact' ||
      lifecycleEvent === 'stop'
    ) {
      return 0;
    }
  }

  const event = mapClaudeCodeEvent(parsed, { project: opts.project, sessionId: opts.sessionId });
  if (!event) return 0;
  let daemon: { baseUrl: string; token: string };
  try {
    daemon = resolveDaemon(opts.storageRoot);
  } catch {
    return 0;
  }

  try {
    await fetch(`${daemon.baseUrl}/observations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch {
    // Best-effort: never fail the hook if observation fails.
  }
  return 0;
}
