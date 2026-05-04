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

export type LifecycleEvent = 'session-start' | 'pre-compact' | 'stop';
export type LifecycleForwardFn = (event: { kind: 'lifecycle'; event: LifecycleEvent }) => Promise<void>;

export async function runLifecycleForward(opts: {
  event: LifecycleEvent;
  cwd: string;
  forwardFn: LifecycleForwardFn;
}): Promise<void> {
  await opts.forwardFn({ kind: 'lifecycle', event: opts.event });
}

export async function defaultLifecycleForwardFn(storageRoot: string, cwd: string): Promise<LifecycleForwardFn> {
  const daemon = resolveDaemon(storageRoot);
  return async (event) => {
    try {
      await fetch(`${daemon.baseUrl}/workflows/trigger`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ event, cwd }),
      });
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

  if (
    (parsed as ClaudeCodeHookEvent | null)?.hook_event_name === 'SessionStart' ||
    (parsed as ClaudeCodeHookEvent | null)?.hook_event_name === 'PreCompact' ||
    (parsed as ClaudeCodeHookEvent | null)?.hook_event_name === 'Stop'
  ) {
    const ev = parsed as ClaudeCodeHookEvent;
    const hookEvent = ev.hook_event_name === 'SessionStart'
      ? 'session-start'
      : ev.hook_event_name === 'PreCompact'
        ? 'pre-compact'
        : 'stop';
    const cwd = typeof ev.cwd === 'string' && ev.cwd.length > 0 ? ev.cwd : process.cwd();
    const forwardFn = await defaultLifecycleForwardFn(opts.storageRoot, cwd);
    await runLifecycleForward({ event: hookEvent, cwd, forwardFn });
    return 0;
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
