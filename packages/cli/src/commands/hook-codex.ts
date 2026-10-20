import type { T0EventInput } from "@penumbra/core";

import { resolveProjectId } from "@penumbra/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CodexHookLaunchContext,
  normalizeCodexHook,
  type NormalizedCodexHook,
  renderCodexHookOutput,
} from "./codex-hook-contract.js";

const TOTAL_BUDGET_MS = 1_500;
const MAX_CONTROL_ID = 128;

export interface RunCodexHookOptions {
  storageRoot: string;
  rawEvent: string;
  project?: string | null;
  sessionId?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  write?: (value: string) => void;
  now?: () => number;
}

type DaemonConnection = { baseUrl: string; token: string };

function nonBlank(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function snapshotEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env };
}

function isSuppressedEnvironment(env: NodeJS.ProcessEnv): boolean {
  const origin = env.PENUMBRA_MCP_ORIGIN?.trim().toLowerCase();
  return (
    origin === "fleet-worker" ||
    origin === "dispatch" ||
    nonBlank(env.PENUMBRA_HANDOFF_ID) ||
    nonBlank(env.PENUMBRA_WORKER_ID) ||
    nonBlank(env.PENUMBRA_LONG_LIVED_AGENT_ID) ||
    nonBlank(env.PENUMBRA_LONG_LIVED_TICK_ID)
  );
}

function roleFromEnvironment(env: NodeJS.ProcessEnv): CodexHookLaunchContext["role"] {
  if (isSuppressedEnvironment(env)) return "dispatch";
  return env.PENUMBRA_MCP_ORIGIN?.trim().toLowerCase() === "maestro" ? "maestro" : "unknown";
}

function parsedRecord(rawEvent: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawEvent);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function boundedControl(value: string | null): string | null {
  return value !== null && value.length <= MAX_CONTROL_ID ? value : null;
}

function launchContext(opts: {
  raw: Record<string, unknown>;
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
}): CodexHookLaunchContext {
  const role = roleFromEnvironment(opts.env);
  const rawSessionId = typeof opts.raw.session_id === "string" ? opts.raw.session_id : null;
  if (rawSessionId && rawSessionId.length <= MAX_CONTROL_ID && opts.sessionId === rawSessionId) {
    return {
      role,
      rootSessionId: rawSessionId,
      provenance: "verified-session-correlation",
    };
  }
  return { role, rootSessionId: null, provenance: "unknown" };
}

function readDaemon(storageRoot: string): DaemonConnection | null {
  try {
    const rawPort = readFileSync(join(storageRoot, "port"), "utf8").trim();
    const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || token.length === 0) return null;
    return { baseUrl: `http://127.0.0.1:${String(port)}`, token };
  } catch {
    return null;
  }
}

function projectId(normalized: NormalizedCodexHook, explicit: string | null): string | null {
  if (explicit) return explicit;
  try {
    return resolveProjectId({ cwd: normalized.cwd }).project_id;
  } catch {
    return null;
  }
}

function safeIdentity(normalized: NormalizedCodexHook): NormalizedCodexHook {
  if (boundedControl(normalized.sessionId) === normalized.sessionId) return normalized;
  return {
    ...normalized,
    role: "unknown",
    lineage: "unknown",
    provenance: "unknown",
    sessionId: null,
    actionableLifecycle: false,
  };
}

function originFor(
  normalized: NormalizedCodexHook,
  suppressed: boolean,
): "maestro" | "dispatch" | "unknown" {
  if (suppressed) return "unknown" as const;
  if (normalized.role === "maestro") return "maestro" as const;
  if (normalized.role === "dispatch") return "dispatch" as const;
  return "unknown" as const;
}

function observationFor(opts: {
  normalized: NormalizedCodexHook;
  project: string | null;
  suppressed: boolean;
}): T0EventInput | null {
  const eventType =
    opts.normalized.event === "PreToolUse"
      ? "agent-tool-use"
      : opts.normalized.event === "SubagentStart"
        ? "agent-thought"
        : opts.normalized.event === "SubagentStop"
          ? "agent-response"
          : null;
  if (!eventType) return null;
  const toolName = opts.normalized.rawToolName;
  const payload = {
    event: opts.normalized.event,
    role: opts.normalized.role,
    lineage: opts.normalized.lineage,
    provenance: opts.normalized.provenance,
    source: boundedControl(opts.normalized.source),
    turn_id: boundedControl(opts.normalized.turnId),
    tool_use_id: boundedControl(opts.normalized.toolUseId),
    tool: boundedControl(toolName),
    tool_activity: opts.normalized.toolActivity,
    agent_id: boundedControl(opts.normalized.agentId),
    agent_type: boundedControl(opts.normalized.agentType),
    parent_session_id: boundedControl(opts.normalized.parentSessionId),
    current_session_id: boundedControl(opts.normalized.sessionId),
  };
  return {
    ts: new Date().toISOString(),
    source: "codex",
    source_detail: toolName ? `tool:${toolName}` : `hook:${opts.normalized.event}`,
    project_id: opts.project,
    session_id: boundedControl(opts.normalized.sessionId),
    event_type: eventType,
    lane: "cli-subscription",
    payload_json: payload,
    payload_summary: toolName ?? opts.normalized.event,
    user_id: "codex",
    machine_id: "local",
    origin: originFor(opts.normalized, opts.suppressed),
  };
}

function lifecycleEvent(event: NormalizedCodexHook["event"]): string {
  return event.replaceAll(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

function ingress(normalized: NormalizedCodexHook): Record<string, unknown> {
  return {
    harness: "codex",
    role: normalized.role,
    lineage: normalized.lineage,
    provenance: normalized.provenance,
    is_child: normalized.isChild,
    parent_session_id: boundedControl(normalized.parentSessionId),
    agent_id: boundedControl(normalized.agentId),
    agent_type: boundedControl(normalized.agentType),
    source: boundedControl(normalized.source),
    turn_id: boundedControl(normalized.turnId),
    tool_use_id: boundedControl(normalized.toolUseId),
    delivery_id: boundedControl(normalized.deliveryId),
    transcript_format: null,
  };
}

function filePath(normalized: NormalizedCodexHook): string | null {
  const input = normalized.rawToolInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const path = (input as Record<string, unknown>).file_path;
  return typeof path === "string" && path.length <= 8_192 ? path : null;
}

function triggerBody(normalized: NormalizedCodexHook): Record<string, unknown> {
  return {
    event: { kind: "lifecycle", event: lifecycleEvent(normalized.event) },
    cwd: normalized.cwd,
    hookContext: {
      tool_name: boundedControl(normalized.rawToolName),
      file_path: filePath(normalized),
    },
    session_id: boundedControl(normalized.sessionId),
    transcript_path: normalized.transcriptPath,
    ingress: ingress(normalized),
  };
}

function touchBody(
  normalized: NormalizedCodexHook,
  project: string | null,
): Record<string, unknown> {
  return { session_id: boundedControl(normalized.sessionId), project_id: project };
}

function defaultWrite(value: string): void {
  process.stdout.write(value);
}

function defaultNow(): number {
  return performance.now();
}

async function forwardCodexHook(opts: {
  normalized: NormalizedCodexHook;
  suppressed: boolean;
  project: string | null;
  daemon: DaemonConnection;
  fetchFn: typeof fetch;
  monotonicNow: () => number;
}): Promise<string | null> {
  const deadlineAt = opts.monotonicNow() + TOTAL_BUDGET_MS;
  const controller = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(
    () => {
      controller.abort();
      rejectDeadline(new Error("codex_hook_deadline"));
    },
    Math.max(0, deadlineAt - opts.monotonicNow()),
  );
  const post = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    if (opts.monotonicNow() >= deadlineAt) throw new Error("codex_hook_deadline");
    const response = await Promise.race([
      opts.fetchFn(`${opts.daemon.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      deadline,
    ]);
    return await Promise.race([response.json(), deadline]);
  };
  const attempt = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    try {
      return await post(path, body);
    } catch {
      return null;
    }
  };
  try {
    if (opts.normalized.actionableLifecycle && !opts.suppressed && opts.normalized.sessionId) {
      await attempt("/sessions/touch", touchBody(opts.normalized, opts.project));
    }
    const observation = observationFor({
      normalized: opts.normalized,
      project: opts.project,
      suppressed: opts.suppressed,
    });
    if (observation) await attempt("/observations", observation);
    if (
      !opts.normalized.actionableLifecycle ||
      opts.suppressed ||
      opts.monotonicNow() >= deadlineAt
    ) {
      return null;
    }
    const response = await attempt("/workflows/trigger", triggerBody(opts.normalized));
    if (!response || typeof response !== "object" || Array.isArray(response)) return null;
    const context = (response as Record<string, unknown>).additionalContext;
    return typeof context === "string" ? context : null;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export async function runCodexHook(opts: RunCodexHookOptions): Promise<number> {
  const write = opts.write ?? defaultWrite;
  let normalized: NormalizedCodexHook | null = null;
  let additionalContext: string | null = null;
  let emitted = false;
  const emitOnce = (): void => {
    if (emitted) return;
    emitted = true;
    write(renderCodexHookOutput(normalized?.event ?? "Stop", additionalContext));
  };
  try {
    const env = snapshotEnvironment(opts.env ?? process.env);
    const suppressed = isSuppressedEnvironment(env);
    const sessionId = opts.sessionId ?? null;
    const explicitProject = opts.project ?? null;
    const raw = parsedRecord(opts.rawEvent);
    if (raw) {
      const normalizedInput = normalizeCodexHook(raw, launchContext({ raw, sessionId, env }));
      if (normalizedInput) {
        normalized = safeIdentity(normalizedInput);
        const daemon = readDaemon(opts.storageRoot);
        if (daemon) {
          additionalContext = await forwardCodexHook({
            normalized,
            suppressed,
            project: projectId(normalized, explicitProject),
            daemon,
            fetchFn: opts.fetchFn ?? fetch,
            monotonicNow: opts.now ?? defaultNow,
          });
        }
      }
    }
  } catch {
    additionalContext = null;
  } finally {
    emitOnce();
  }
  return 0;
}
