import type { T0EventInput } from "@penumbra/core";

import { resolveProjectId } from "@penumbra/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  transcript_path?: string | null;
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const port = readFileSync(join(storageRoot, "port"), "utf8").trim();
  const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
  if (!port || Number.isNaN(Number(port))) {
    throw new Error(`penumbra hook: invalid daemon port in ${join(storageRoot, "port")}`);
  }
  if (!token) {
    throw new Error(`penumbra hook: empty daemon token in ${join(storageRoot, "token")}`);
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export type LifecycleEvent =
  | "session-start"
  | "session-end"
  | "pre-compact"
  | "stop"
  | "user-prompt-submit"
  | "pre-tool-use"
  | "post-tool-use";
export type LifecycleHookContext = {
  tool_name?: string | null;
  file_path?: string | null;
};
export type LifecycleForwardFn = (event: {
  kind: "lifecycle";
  event: LifecycleEvent;
  hookContext?: LifecycleHookContext;
}) => Promise<void>;

export async function runLifecycleForward(opts: {
  event: LifecycleEvent;
  cwd: string;
  forwardFn: LifecycleForwardFn;
  hookContext?: LifecycleHookContext;
}): Promise<void> {
  await opts.forwardFn({ kind: "lifecycle", event: opts.event, hookContext: opts.hookContext });
}

export function lifecycleToHookEventName(event: LifecycleEvent): string {
  switch (event) {
    case "session-start":
      return "SessionStart";
    case "session-end":
      return "SessionEnd";
    case "pre-compact":
      return "PreCompact";
    case "stop":
      return "Stop";
    case "user-prompt-submit":
      return "UserPromptSubmit";
    case "pre-tool-use":
      return "PreToolUse";
    case "post-tool-use":
      return "PostToolUse";
    default:
      return event;
  }
}

export function claudeCodeEventToLifecycle(name: string | undefined | null): LifecycleEvent | null {
  switch (name) {
    case undefined:
    case null:
      return null;
    case "SessionStart":
      return "session-start";
    case "SessionEnd":
      return "session-end";
    case "PreCompact":
      return "pre-compact";
    case "Stop":
      return "stop";
    case "UserPromptSubmit":
      return "user-prompt-submit";
    case "PreToolUse":
      return "pre-tool-use";
    case "PostToolUse":
      return "post-tool-use";
    default:
      return null;
  }
}

export function defaultLifecycleForwardFn(
  storageRoot: string,
  cwd: string,
  sessionContext?: {
    sessionId?: string | null;
    projectId?: string | null;
    transcriptPath?: string | null;
  },
): LifecycleForwardFn {
  const daemon = resolveDaemon(storageRoot);
  return async (event) => {
    try {
      const res = await fetch(`${daemon.baseUrl}/workflows/trigger`, {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          event,
          cwd,
          hookContext: {
            tool_name: event.hookContext?.tool_name ?? null,
            file_path: event.hookContext?.file_path ?? null,
          },
          session_id: sessionContext?.sessionId ?? null,
          transcript_path: sessionContext?.transcriptPath ?? null,
        }),
      });
      const data = (await res.json().catch(() => null)) as { additionalContext?: unknown } | null;
      const additionalContext = data?.additionalContext;
      if (typeof additionalContext === "string" && additionalContext.length > 0) {
        const envelope = {
          hookSpecificOutput: {
            hookEventName: lifecycleToHookEventName(event.event),
            additionalContext,
          },
        };
        process.stdout.write(JSON.stringify(envelope) + "\n");
      }
    } catch {
      // Best-effort: never fail the hook if lifecycle forwarding fails.
    }
  };
}

// classifyOrigin tags an observation by its session lineage so recall can
// filter on a stable categorical field rather than per-id deny lists.
//   - 'dispatch' — chain conversation (session_id starts with 'conv-')
//   - 'maestro'  — Claude Code session (UUID-shaped session_id)
//   - 'unknown'  — manual API calls, tests, missing session_id
export function classifyOrigin(sessionId: string | null): "maestro" | "dispatch" | "unknown" {
  if (!sessionId) return "unknown";
  if (sessionId.startsWith("conv-")) return "dispatch";
  if (/^[0-9a-f]{8}-/i.test(sessionId)) return "maestro";
  return "unknown";
}

interface MapBaseFields {
  ts: string;
  projectId: string | null;
  sessionId: string | null;
  origin: "maestro" | "dispatch" | "unknown";
}

function shouldDropRecallSelfReference(ev: ClaudeCodeHookEvent): boolean {
  if (ev.hook_event_name !== "PreToolUse" && ev.hook_event_name !== "PostToolUse") return false;
  const toolName = typeof ev.tool_name === "string" ? ev.tool_name : "";
  return toolName === "mcp__penumbra__memory_recall";
}

function resolveProjectIdForEvent(ev: ClaudeCodeHookEvent, opts: MapOpts): string | null {
  let projectId: string | null = opts.project ?? null;
  if (!projectId && typeof ev.cwd === "string" && ev.cwd.length > 0) {
    try {
      projectId = resolveProjectId({ cwd: ev.cwd }).project_id;
    } catch {
      // Best-effort: if git isn't available or cwd is gone, fall through to null.
    }
  }
  return projectId;
}

export function mapClaudeCodeEvent(raw: unknown, opts: MapOpts): T0EventInput | null {
  if (!raw || typeof raw !== "object") return null;
  const ev = raw as ClaudeCodeHookEvent;
  const projectId = resolveProjectIdForEvent(ev, opts);
  const sessionId = opts.sessionId ?? ev.session_id ?? null;
  const base: MapBaseFields = {
    ts: new Date().toISOString(),
    projectId,
    sessionId,
    origin: classifyOrigin(sessionId),
  };

  if (shouldDropRecallSelfReference(ev)) return null;

  switch (ev.hook_event_name) {
    case undefined:
      return null;
    case "UserPromptSubmit": {
      const prompt = typeof ev.prompt === "string" ? ev.prompt : "";
      return {
        ts: base.ts,
        source: "claude-code",
        source_detail: "user-prompt",
        project_id: base.projectId,
        session_id: base.sessionId,
        event_type: "agent-prompt",
        lane: "cli-subscription",
        payload_json: { prompt, cwd: ev.cwd ?? null },
        payload_summary: prompt.length > 0 ? prompt.slice(0, 240) : null,
        user_id: "claude-code",
        machine_id: "local",
        origin: base.origin,
      };
    }
    case "PreToolUse": {
      const toolName = typeof ev.tool_name === "string" ? ev.tool_name : "unknown";
      const input = ev.tool_input ?? null;
      const summary = `${toolName}(${JSON.stringify(input ?? {}).slice(0, 200)})`;
      return {
        ts: base.ts,
        source: "claude-code",
        source_detail: `tool:${toolName}`,
        project_id: base.projectId,
        session_id: base.sessionId,
        event_type: "agent-tool-use",
        lane: "cli-subscription",
        payload_json: { tool: toolName, input },
        payload_summary: summary,
        user_id: "claude-code",
        machine_id: "local",
        origin: base.origin,
      };
    }
    case "PostToolUse": {
      const toolName = typeof ev.tool_name === "string" ? ev.tool_name : "unknown";
      const out = ev.tool_response ?? null;
      const summary = `${toolName} -> ${JSON.stringify(out ?? {}).slice(0, 200)}`;
      return {
        ts: base.ts,
        source: "claude-code",
        source_detail: `tool-response:${toolName}`,
        project_id: base.projectId,
        session_id: base.sessionId,
        event_type: "agent-response",
        lane: "cli-subscription",
        payload_json: { tool: toolName, response: out },
        payload_summary: summary,
        user_id: "claude-code",
        machine_id: "local",
        origin: base.origin,
      };
    }
    case "SessionStart":
    case "PreCompact":
    case "Stop": {
      return null;
    }
    default:
      return null;
  }
}

async function touchSession(
  storageRoot: string,
  sessionId: string,
  projectId: string | null,
): Promise<void> {
  try {
    const daemon = resolveDaemon(storageRoot);
    await fetch(`${daemon.baseUrl}/sessions/touch`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, project_id: projectId }),
    });
  } catch {
    // Best-effort
  }
}

async function dispatchLifecycle(
  opts: RunHookOpts,
  lifecycleEvent: LifecycleEvent,
  ev: ClaudeCodeHookEvent | null,
  sessionId: string | null,
  projectIdForTouch: string | null,
  cwd: string,
): Promise<void> {
  const transcriptPath = typeof ev?.transcript_path === "string" ? ev.transcript_path : null;
  const toolNameForCtx = typeof ev?.tool_name === "string" ? ev.tool_name : null;
  const toolInputForCtx = ev?.tool_input as { file_path?: unknown } | null | undefined;
  const filePathForCtx =
    toolInputForCtx && typeof toolInputForCtx.file_path === "string"
      ? toolInputForCtx.file_path
      : null;
  try {
    const forwardFn = defaultLifecycleForwardFn(opts.storageRoot, cwd, {
      sessionId,
      projectId: projectIdForTouch,
      transcriptPath,
    });
    await runLifecycleForward({
      event: lifecycleEvent,
      cwd,
      forwardFn,
      hookContext: { tool_name: toolNameForCtx, file_path: filePathForCtx },
    });
  } catch {
    // Best-effort
  }
}

function resolveTouchProjectId(opts: RunHookOpts, cwdForResolve: string): string | null {
  let projectIdForTouch: string | null = opts.project ?? null;
  if (!projectIdForTouch) {
    try {
      projectIdForTouch = resolveProjectId({ cwd: cwdForResolve }).project_id;
    } catch {
      projectIdForTouch = null;
    }
  }
  return projectIdForTouch;
}

function isLifecycleTerminator(lifecycleEvent: LifecycleEvent): boolean {
  return (
    lifecycleEvent === "session-start" ||
    lifecycleEvent === "pre-compact" ||
    lifecycleEvent === "stop"
  );
}

function isNonBlankEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isLongLivedAgentEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    isNonBlankEnvValue(env.PENUMBRA_LONG_LIVED_TICK_ID) ||
    isNonBlankEnvValue(env.PENUMBRA_LONG_LIVED_AGENT_ID)
  );
}

export function isSdkEntrypointEnv(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDE_CODE_ENTRYPOINT?.trim().toLowerCase().startsWith("sdk") ?? false;
}

export function shouldSkipLifecycleForwarding(env: NodeJS.ProcessEnv): boolean {
  return isLongLivedAgentEnv(env) || isSdkEntrypointEnv(env);
}

function snapshotLifecycleForwardingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    CLAUDE_CODE_ENTRYPOINT: env.CLAUDE_CODE_ENTRYPOINT,
    PENUMBRA_LONG_LIVED_AGENT_ID: env.PENUMBRA_LONG_LIVED_AGENT_ID,
    PENUMBRA_LONG_LIVED_TICK_ID: env.PENUMBRA_LONG_LIVED_TICK_ID,
  };
}

async function runLifecycleHook(opts: {
  hookOpts: RunHookOpts;
  lifecycleEvent: LifecycleEvent | null;
  ev: ClaudeCodeHookEvent | null;
  sessionId: string | null;
  projectIdForTouch: string | null;
  cwdForResolve: string;
  skipLifecycleForwarding: boolean;
}): Promise<boolean> {
  if (!opts.lifecycleEvent) return false;

  // SDK-driven sessions (penumbra long-lived ticks run through claude-agent-acp)
  // and long-lived markers both mean this is not an interactive maestro session:
  // no prime, no continuity rows, no draft dispatch, no memory sweep. touchSession
  // and the /observations post stay. CLAUDE_CODE_ENTRYPOINT is undocumented; match
  // the sdk* prefix intentionally (registrar ev260 / ev282).
  if (!opts.skipLifecycleForwarding) {
    await dispatchLifecycle(
      opts.hookOpts,
      opts.lifecycleEvent,
      opts.ev,
      opts.sessionId,
      opts.projectIdForTouch,
      opts.cwdForResolve,
    );
  }
  return isLifecycleTerminator(opts.lifecycleEvent);
}

export async function runHook(opts: RunHookOpts): Promise<number> {
  const portPath = join(opts.storageRoot, "port");
  const tokenPath = join(opts.storageRoot, "token");
  if (!existsSync(portPath) || !existsSync(tokenPath)) {
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
  const cwdForResolve = typeof ev?.cwd === "string" && ev.cwd.length > 0 ? ev.cwd : process.cwd();
  const lifecycleForwardingEnv = snapshotLifecycleForwardingEnv(process.env);
  const projectIdForTouch = resolveTouchProjectId(opts, cwdForResolve);
  if (sessionId) {
    await touchSession(opts.storageRoot, sessionId, projectIdForTouch);
  }

  const lifecycleEvent = claudeCodeEventToLifecycle(ev?.hook_event_name);
  const skipLifecycleForwarding = shouldSkipLifecycleForwarding(lifecycleForwardingEnv);
  const lifecycleTerminated = await runLifecycleHook({
    hookOpts: opts,
    lifecycleEvent,
    ev,
    sessionId,
    projectIdForTouch,
    cwdForResolve,
    skipLifecycleForwarding,
  });
  if (lifecycleTerminated) return 0;

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
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch {
    // Best-effort
  }
  return 0;
}
