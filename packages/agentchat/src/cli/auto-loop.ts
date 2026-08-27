import type { AgentChatConfig } from "../config/types.js";

import { dispatchHandoff } from "./dispatch-handoff.js";
import { type ChatTurnInput, type ChatTurnResult, runChatTurn as realRunChatTurn } from "./loop.js";

interface CreateHandoffBody {
  from: string;
  to: string;
  to_role?: string | null;
  message: string;
  conversation_id: string;
  project_id?: string | null;
  triggered_by_event_id: string;
  use_worktree?: boolean | number | null;
  chain_task_type?: string | null;
}

export interface AutoChainOpts {
  config: AgentChatConfig;
  initialAgent: string;
  userMessage: string;
  conversation: { id: string; project_id: string | null };
  maxHops: number;
  transcriptBudget: number;
  observe: (event: Record<string, unknown>) => Promise<{ event_id: string }>;
  createHandoff: (body: CreateHandoffBody) => Promise<{
    handoff_id: string;
    status: string;
    routed_agent?: string;
    routed_role?: string;
    routing_task_type?: string;
  }>;
  approve: (
    id: string,
    body: { resolved_by?: string; redirect_to?: string; reject?: boolean; reason?: string },
  ) => Promise<{ handoff_id: string; status: string }>;
  markFailed?: (
    handoff_id: string,
    reason: string,
  ) => Promise<{ handoff_id: string; status: string }>;
  runChatTurn?: (input: ChatTurnInput) => Promise<ChatTurnResult>;
  trustMode?: "all" | "config";
  projectContext?: string;
  onChunk?: (delta: string) => void;
  log?: { error: (obj: Record<string, unknown>, msg: string) => void };
  /** optional: override retry sleep (tests). */
  delay?: (ms: number) => Promise<void>;
}

export interface AutoChainResult {
  hops: number;
  terminatedReason: "no_mention" | "max_hops" | "untrusted" | "error" | "handoff_creation_failed";
  cappedHandoffId?: string;
}

interface CurrentHandoff {
  handoff_id?: string;
  from_agent: string;
  to_agent: string;
  message: string;
}

type TerminalReason = "completed" | "max_hops" | "untrusted" | "error";

function withCap(
  base: { hops: number; terminatedReason: AutoChainResult["terminatedReason"] },
  cappedHandoffId: string | undefined,
): AutoChainResult {
  return cappedHandoffId !== undefined ? { ...base, cappedHandoffId } : base;
}

function emitTerminate(
  observe: AutoChainOpts["observe"],
  conversation: AutoChainOpts["conversation"],
  state: { reason: TerminalReason; hops: number; cappedHandoffId?: string },
): Promise<void> {
  return observe({
    ts: new Date().toISOString(),
    source: "agentchat",
    event_type: "chain-terminated",
    lane: "cli-subscription",
    session_id: conversation.id,
    project_id: conversation.project_id,
    user_id: "local-user",
    machine_id: "local",
    payload_json: {
      reason: state.reason,
      hop_count: state.hops,
      conversation_id: conversation.id,
      terminal_handoff_id: state.cappedHandoffId,
    },
  }).then(() => undefined);
}

interface StepInput {
  opts: AutoChainOpts;
  trustMode: "all" | "config";
  transcript: { agent: string; text: string }[];
  currentHandoff: CurrentHandoff;
  hops: number;
}

interface StepFinished {
  kind: "finished";
  result: AutoChainResult;
  reason: TerminalReason;
  cappedHandoffId?: string;
}

interface StepContinue {
  kind: "continue";
  next: CurrentHandoff;
  text: string;
}

async function runOneStep(input: StepInput): Promise<StepFinished | StepContinue> {
  const { opts, trustMode, transcript, currentHandoff, hops } = input;
  process.stdout.write(`\n[${currentHandoff.to_agent}]\n`);
  const res = await dispatchHandoff({
    handoff: currentHandoff,
    config: opts.config,
    conversation: opts.conversation,
    transcript,
    transcriptBudget: opts.transcriptBudget,
    hopsSoFar: hops - 1,
    maxHops: opts.maxHops,
    trustMode,
    projectContext: opts.projectContext,
    observe: opts.observe,
    createHandoff: opts.createHandoff,
    approve: opts.approve,
    markFailed: opts.markFailed,
    runChatTurn: opts.runChatTurn ?? realRunChatTurn,
    onChunk: opts.onChunk,
    log: opts.log,
    delay: opts.delay,
  });
  process.stdout.write("\n\n");

  if (res.terminatedReason === "no_mention") {
    return {
      kind: "finished",
      reason: "completed",
      result: { hops, terminatedReason: "no_mention" },
    };
  }
  if (res.terminatedReason === "max_hops") {
    return {
      kind: "finished",
      reason: "max_hops",
      cappedHandoffId: res.cappedHandoffId,
      result: withCap({ hops, terminatedReason: "max_hops" }, res.cappedHandoffId),
    };
  }
  if (res.terminatedReason === "untrusted") {
    const nextTo = res.next ? res.next.to : "?";
    const capId = res.cappedHandoffId ?? "";
    process.stdout.write(
      `[untrusted edge ${currentHandoff.to_agent}→${nextTo}, handoff ${capId.slice(0, 8)} queued]\n`,
    );
    return {
      kind: "finished",
      reason: "untrusted",
      cappedHandoffId: res.cappedHandoffId,
      result: withCap({ hops, terminatedReason: "untrusted" }, res.cappedHandoffId),
    };
  }
  if (res.terminatedReason === "error" || res.terminatedReason === "handoff_creation_failed") {
    const cap = res.cappedHandoffId ?? currentHandoff.handoff_id;
    return {
      kind: "finished",
      reason: "error",
      cappedHandoffId: cap,
      result: withCap({ hops, terminatedReason: res.terminatedReason }, cap),
    };
  }

  if (!res.next) {
    return {
      kind: "finished",
      reason: "error",
      cappedHandoffId: currentHandoff.handoff_id,
      result: withCap({ hops, terminatedReason: "error" }, currentHandoff.handoff_id),
    };
  }

  process.stdout.write(`[auto-approved → ${res.next.to}]\n`);
  return {
    kind: "continue",
    text: res.text,
    next: {
      handoff_id: res.next.handoff_id,
      from_agent: res.next.from,
      to_agent: res.next.to,
      message: res.next.message,
    },
  };
}

export async function runAutoChain(opts: AutoChainOpts): Promise<AutoChainResult> {
  const trustMode = opts.trustMode ?? "all";
  const transcript: { agent: string; text: string }[] = [{ agent: "user", text: opts.userMessage }];

  // Synthesize an initial chain-start handoff for the loop. We never persist this row;
  // dispatchHandoff treats from_agent === 'user' specially (no transcript wrap).
  let currentHandoff: CurrentHandoff = {
    from_agent: "user",
    to_agent: opts.initialAgent,
    message: opts.userMessage,
  };

  let hops = 0;
  let reason: TerminalReason = "error";
  let cappedHandoffId: string | undefined;

  try {
    for (;;) {
      hops++;
      const step = await runOneStep({ opts, trustMode, transcript, currentHandoff, hops });
      if (step.kind === "finished") {
        reason = step.reason;
        cappedHandoffId = step.cappedHandoffId;
        return step.result;
      }
      transcript.push({ agent: currentHandoff.to_agent, text: step.text });
      currentHandoff = step.next;
    }
  } catch (err) {
    reason = "error";
    throw err;
  } finally {
    try {
      await emitTerminate(opts.observe, opts.conversation, { reason, hops, cappedHandoffId });
    } catch (err) {
      console.error("chain-terminated telemetry failed:", err);
    }
  }
}
