import type { DispatchEventInput } from "@penumbra/core";
import type { RuntimeThoughtsConfig } from "./thought-config.js";

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
  }) => Promise<{ responses: Array<{ text?: string }> }>;
  recordEvent: (event: DispatchEventInput) => Promise<void> | void;
  log: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void } | typeof console;
  getHandoff?: (handoffId: string) => Promise<{ project_id: string | null } | null>;
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
    const piece = `[#${row.sequence_n} ${row.adapter}/${row.agent_name}] ${row.text}\n`;
    if (used + piece.length > limit) break;
    kept.push(row);
    used += piece.length;
  }
  const truncated = kept.length < rows.length;
  const ordered = kept.reverse();
  return {
    body: ordered
      .map((r) => `[#${r.sequence_n} ${r.adapter}/${r.agent_name}] ${r.text}`)
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

export async function runThoughtAnalyzer(input: ThoughtAnalyzerInput): Promise<void> {
  const { handoffId, thoughts, mergeStatus, config, deps } = input;
  if (!config.analyze.enabled) return;
  if (!config.analyze.onlyWhen.includes(mergeStatus)) return;
  if (thoughts.length === 0) return;

  const ts = (deps.now ?? (() => new Date()))().toISOString();
  const tasks: Array<Promise<void>> = [];
  let parentProjectId: string | null | undefined;
  if (deps.getHandoff) {
    try {
      const parentHandoff = await deps.getHandoff(handoffId);
      parentProjectId = parentHandoff?.project_id ?? null;
    } catch {
      parentProjectId = null;
    }
  }

  if (config.analyze.digest.enabled) {
    const cap = config.analyze.digest.maxInputChars;
    const { body, truncated } = joinThoughtsForPrompt(thoughts, cap);
    const prompt = [
      "Summarize the agent reasoning below in 2-4 sentences. Focus on the final approach, not abandoned steps.",
      truncated ? "(Stream truncated; only most recent thoughts shown.)" : "",
      "---",
      body,
    ]
      .filter(Boolean)
      .join("\n");

    tasks.push(
      runOneSubHandoff(
        config.analyze.digest.agent,
        prompt,
        handoffId,
        config.analyze.digest.timeoutMs,
        parentProjectId,
        deps,
      )
        .then(async (text) => {
          await deps.recordEvent({
            handoff_id: handoffId,
            worker_id: deps.workerId ?? null,
            source: "worker",
            kind: "agent.thought.digest",
            ts,
            meta: { digester_agent: config.analyze.digest.agent, digest_text: text },
          });
        })
        .catch(async (err) => {
          deps.log.warn?.("thought analyzer digest failed", { handoffId, err: String(err) });
          await deps.recordEvent({
            handoff_id: handoffId,
            worker_id: deps.workerId ?? null,
            source: "worker",
            kind: "agent.thought.digest",
            ts,
            meta: {
              digester_agent: config.analyze.digest.agent,
              digest_text: `<analyzer failed: ${String(err)}>`,
            },
          });
        }),
    );
  }

  if (config.analyze.signals.enabled) {
    const cap = config.analyze.signals.maxInputChars ?? config.analyze.digest.maxInputChars;
    const { body, truncated } = joinThoughtsForPrompt(thoughts, cap);
    for (const def of config.analyze.signals.definitions) {
      const prompt = [
        def.prompt,
        truncated ? "(Stream truncated; only most recent thoughts shown.)" : "",
        "---",
        body,
      ]
        .filter(Boolean)
        .join("\n");
      tasks.push(
        runOneSubHandoff(
          config.analyze.signals.agent,
          prompt,
          handoffId,
          config.analyze.signals.timeoutMs,
          parentProjectId,
          deps,
        )
          .then(async (text) => {
            await deps.recordEvent({
              handoff_id: handoffId,
              worker_id: deps.workerId ?? null,
              source: "worker",
              kind: "agent.thought.signal",
              ts,
              meta: {
                signal_name: def.name,
                evidence_text: text,
                extractor_agent: config.analyze.signals.agent,
              },
            });
          })
          .catch(async (err) => {
            deps.log.warn?.("thought analyzer signal failed", {
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
                extractor_agent: config.analyze.signals.agent,
              },
            });
          }),
      );
    }
  }

  await Promise.all(tasks);
}
