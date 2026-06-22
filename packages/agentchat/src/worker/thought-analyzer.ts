import type { AgentPool } from "@penumbra/config";

import { type DispatchEventInput } from "@penumbra/core";

import type { RuntimeThoughtsConfig } from "./thought-config.js";

import {
  type DroppedAgentPoolMember,
  resolveAgentPool,
  type ResolveAgentPoolContext,
} from "../../../core/src/services/agent-routing.js";

export interface ThoughtRow {
  sequence_n: number;
  adapter: string;
  agent_name: string;
  text: string;
  token_count?: number;
}

export interface ThoughtAnalyzerDeps {
  chainStart: (input: {
    initial_agent: string;
    message: string;
    dispatch_kind?: "thought_analyzer";
    project_id?: string | null;
    parent_handoff_id?: string;
    task_type?: string;
  }) => Promise<{ conversation_id: string; handoff_id: string }>;
  chainWait: (input: {
    conversation_id: string;
    timeout_ms?: number;
  }) => Promise<{ status: "completed" | "failed" | "timeout" }>;
  chainResponse: (input: {
    conversation_id: string;
  }) => Promise<{ responses: { text?: string }[] }>;
  recordEvent: (event: DispatchEventInput) => Promise<void> | void;
  log: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void } | typeof console;
  getHandoff?: (handoffId: string) => Promise<{ project_id: string | null } | null>;
  agentPool?: ResolveAgentPoolContext & {
    prepare?: (pool: AgentPool | null) => Promise<void>;
  };
  workerId?: string | null;
  now?: () => Date;
}

export interface ThoughtAnalyzerInput {
  handoffId: string;
  thoughts: ThoughtRow[];
  mergeStatus: string;
  config: RuntimeThoughtsConfig;
  deps: ThoughtAnalyzerDeps;
}

function joinThoughtsForPrompt(
  rows: ThoughtRow[],
  limit: number,
): { body: string; truncated: boolean } {
  const reversed = [...rows].reverse();
  const kept: ThoughtRow[] = [];
  let used = 0;
  for (const row of reversed) {
    const piece = `[#${String(row.sequence_n)} ${row.adapter}/${row.agent_name}] ${row.text}\n`;
    if (used + piece.length > limit) break;
    kept.push(row);
    used += piece.length;
  }
  const truncated = kept.length < rows.length;
  const ordered = kept.reverse();
  return {
    body: ordered
      .map((r) => `[#${String(r.sequence_n)} ${r.adapter}/${r.agent_name}] ${r.text}`)
      .join("\n"),
    truncated,
  };
}

async function runOneSubHandoff(
  agent: string,
  prompt: string,
  parentHandoffId: string,
  timeoutMs: number,
  projectId: string | null | undefined,
  deps: ThoughtAnalyzerDeps,
): Promise<string> {
  const started = await deps.chainStart({
    initial_agent: agent,
    message: prompt,
    dispatch_kind: "thought_analyzer",
    parent_handoff_id: parentHandoffId,
    project_id: projectId,
    task_type: "unknown",
  });
  const wait = await deps.chainWait({
    conversation_id: started.conversation_id,
    timeout_ms: timeoutMs,
  });
  if (wait.status !== "completed") throw new Error(`sub-handoff did not complete: ${wait.status}`);
  const resp = await deps.chainResponse({ conversation_id: started.conversation_id });
  return resp.responses[resp.responses.length - 1]?.text ?? "";
}

async function runPooledAnalyzerHandoff(input: {
  pool: AgentPool | null;
  prompt: string;
  parentHandoffId: string;
  timeoutMs: number;
  projectId: string | null | undefined;
  deps: ThoughtAnalyzerDeps;
  logContext: Record<string, unknown>;
  label: "digest" | "signal";
}): Promise<
  | { status: "ok"; agent: string; text: string }
  | {
      status: "empty";
      dropped: DroppedAgentPoolMember[];
    }
  | { status: "failed"; tried: number }
> {
  const { pool, prompt, parentHandoffId, timeoutMs, projectId, deps, logContext, label } = input;
  if (pool === null) {
    deps.log.warn(`thought analyzer ${label} pool empty`, {
      ...logContext,
      dropped: [],
      reason: "missing-pool",
    });
    return { status: "empty", dropped: [] };
  }

  await deps.agentPool?.prepare?.(pool);
  const resolved = resolveAgentPool(pool, deps.agentPool ?? { registry: [] });
  if (resolved.ordered.length === 0) {
    deps.log.warn(`thought analyzer ${label} pool empty`, {
      ...logContext,
      dropped: resolved.dropped,
    });
    return { status: "empty", dropped: resolved.dropped };
  }

  for (const member of resolved.ordered) {
    try {
      const text = await runOneSubHandoff(
        member.agent,
        prompt,
        parentHandoffId,
        timeoutMs,
        projectId,
        deps,
      );
      if (text.trim().length > 0) return { status: "ok", agent: member.agent, text };
      deps.log.warn(`thought analyzer ${label} member produced no output`, {
        ...logContext,
        agent: member.agent,
      });
    } catch (err) {
      deps.log.warn(`thought analyzer ${label} member failed`, {
        ...logContext,
        agent: member.agent,
        err: String(err),
      });
    }
  }

  return { status: "failed", tried: resolved.ordered.length };
}

function buildAnalyzerPrompt(opening: string, truncated: boolean, body: string): string {
  return [
    opening,
    truncated ? "(Stream truncated; only most recent thoughts shown.)" : "",
    "---",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

type PooledAnalyzerResult =
  | { status: "ok"; agent: string; text: string }
  | { status: "empty"; dropped: DroppedAgentPoolMember[] }
  | { status: "failed"; tried: number };

function describePoolResult(result: PooledAnalyzerResult): string {
  if (result.status === "ok") return result.text;
  if (result.status === "empty") return "<no analyzer available: pool empty>";
  return `<analyzer failed: all ${String(result.tried)} pool members failed>`;
}

async function getParentProjectId(
  deps: ThoughtAnalyzerDeps,
  handoffId: string,
): Promise<string | null | undefined> {
  if (!deps.getHandoff) return undefined;
  try {
    const parentHandoff = await deps.getHandoff(handoffId);
    return parentHandoff?.project_id ?? null;
  } catch {
    return null;
  }
}

function scheduleDigestTask(args: {
  handoffId: string;
  thoughts: ThoughtRow[];
  ts: string;
  config: RuntimeThoughtsConfig;
  deps: ThoughtAnalyzerDeps;
  parentProjectId: string | null | undefined;
}): Promise<void> {
  const { handoffId, thoughts, ts, config, deps, parentProjectId } = args;
  const cap = config.analyze.digest.maxInputChars;
  const { body, truncated } = joinThoughtsForPrompt(thoughts, cap);
  const prompt = buildAnalyzerPrompt(
    "Summarize the agent reasoning below in 2-4 sentences. Focus on the final approach, not abandoned steps.",
    truncated,
    body,
  );

  return runPooledAnalyzerHandoff({
    pool: config.analyze.digest.pool,
    prompt,
    parentHandoffId: handoffId,
    timeoutMs: config.analyze.digest.timeoutMs,
    projectId: parentProjectId,
    deps,
    label: "digest",
    logContext: { handoffId },
  })
    .then(async (result) => {
      await deps.recordEvent({
        handoff_id: handoffId,
        worker_id: deps.workerId ?? null,
        source: "worker",
        kind: "agent.thought.digest",
        ts,
        meta: {
          digester_agent: result.status === "ok" ? result.agent : null,
          digest_text: describePoolResult(result),
        },
      });
    })
    .catch(async (err: unknown) => {
      deps.log.warn("thought analyzer digest failed", { handoffId, err: String(err) });
      await deps.recordEvent({
        handoff_id: handoffId,
        worker_id: deps.workerId ?? null,
        source: "worker",
        kind: "agent.thought.digest",
        ts,
        meta: {
          digester_agent: null,
          digest_text: `<analyzer failed: ${String(err)}>`,
        },
      });
    });
}

function scheduleSignalTasks(args: {
  handoffId: string;
  thoughts: ThoughtRow[];
  ts: string;
  config: RuntimeThoughtsConfig;
  deps: ThoughtAnalyzerDeps;
  parentProjectId: string | null | undefined;
}): Promise<void>[] {
  const { handoffId, thoughts, ts, config, deps, parentProjectId } = args;
  const cap = config.analyze.signals.maxInputChars ?? config.analyze.digest.maxInputChars;
  const { body, truncated } = joinThoughtsForPrompt(thoughts, cap);
  return config.analyze.signals.definitions.map((def) => {
    const prompt = buildAnalyzerPrompt(def.prompt, truncated, body);
    return runPooledAnalyzerHandoff({
      pool: config.analyze.signals.pool,
      prompt,
      parentHandoffId: handoffId,
      timeoutMs: config.analyze.signals.timeoutMs,
      projectId: parentProjectId,
      deps,
      label: "signal",
      logContext: { handoffId, signal: def.name },
    })
      .then(async (result) => {
        await deps.recordEvent({
          handoff_id: handoffId,
          worker_id: deps.workerId ?? null,
          source: "worker",
          kind: "agent.thought.signal",
          ts,
          meta: {
            signal_name: def.name,
            evidence_text: describePoolResult(result),
            extractor_agent: result.status === "ok" ? result.agent : null,
          },
        });
      })
      .catch(async (err: unknown) => {
        deps.log.warn("thought analyzer signal failed", {
          handoffId,
          signal: def.name,
          err: String(err),
        });
        await deps.recordEvent({
          handoff_id: handoffId,
          worker_id: deps.workerId ?? null,
          source: "worker",
          kind: "agent.thought.signal",
          ts,
          meta: {
            signal_name: def.name,
            evidence_text: `<analyzer failed: ${String(err)}>`,
            extractor_agent: null,
          },
        });
      });
  });
}

export async function runThoughtAnalyzer(input: ThoughtAnalyzerInput): Promise<void> {
  const { handoffId, thoughts, mergeStatus, config, deps } = input;
  if (!config.analyze.enabled) return;
  if (!config.analyze.onlyWhen.includes(mergeStatus)) return;
  if (thoughts.length === 0) return;

  const ts = (deps.now ?? ((): Date => new Date()))().toISOString();
  const tasks: Promise<void>[] = [];
  const parentProjectId = await getParentProjectId(deps, handoffId);

  if (config.analyze.digest.enabled) {
    tasks.push(scheduleDigestTask({ handoffId, thoughts, ts, config, deps, parentProjectId }));
  }

  if (config.analyze.signals.enabled) {
    tasks.push(...scheduleSignalTasks({ handoffId, thoughts, ts, config, deps, parentProjectId }));
  }

  await Promise.all(tasks);
}
