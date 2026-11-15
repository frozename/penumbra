import { DREAMING_JUDGE_PROMPT_OUTPUT, DREAMING_JUDGE_PROMPT_PREAMBLE } from "./judge-prompt.js";

export type P1InputContract = "v1" | "v2";

export type P1AuthorClass = "human" | "agent" | "unknown";

export type P1SkipReason =
  | "unusable_excerpt"
  | "t2_owned"
  | "agent_authored"
  | "unknown_origin"
  | "provenance_mismatch";

// The t0 event T1 took first_prompt_excerpt from: the session's first
// 'agent-prompt'. payload_summary is what T1 copied into the excerpt.
export interface P1PromptProvenance {
  source: string | null;
  source_detail: string | null;
  payload_summary: string | null;
}

export type P1PromotionInputArgs =
  | { contract: "v1"; excerpt: string | null }
  | {
      contract: "v2";
      excerpt: string | null;
      nEvents: number;
      t2MinEvents: number;
      firstPrompt: P1PromptProvenance | null;
    };

export type P1PromotionInput =
  | { eligible: true; body: string }
  | { eligible: false; reason: P1SkipReason };

export const P1_MIN_EXCERPT_CHARS = 40;

export function resolveP1InputContract(value: unknown): P1InputContract {
  return value === "v2" ? "v2" : "v1";
}

// Only a prompt a person typed into Claude Code counts as human. Anything an
// agent or the dispatcher composed (agentchat worker prompts, chain-start
// text) is agent; every other shape is unknown and never trusted as human.
export function authorClass(
  row: Pick<P1PromptProvenance, "source" | "source_detail"> | null | undefined,
): P1AuthorClass {
  if (!row) return "unknown";
  if (row.source === "claude-code" && row.source_detail === "user-prompt") return "human";
  if (row.source === "agentchat" || row.source_detail === "chain-start") return "agent";
  return "unknown";
}

export function buildP1PromotionInput(args: P1PromotionInputArgs): P1PromotionInput {
  const excerpt = args.excerpt;
  if (args.contract === "v2" && args.nEvents >= args.t2MinEvents) {
    return { eligible: false, reason: "t2_owned" };
  }
  if (!excerpt || excerpt.trim().length < P1_MIN_EXCERPT_CHARS) {
    return { eligible: false, reason: "unusable_excerpt" };
  }
  if (args.contract === "v1") return { eligible: true, body: excerpt };

  const author = authorClass(args.firstPrompt);
  if (author === "agent") return { eligible: false, reason: "agent_authored" };
  if (author === "unknown") return { eligible: false, reason: "unknown_origin" };
  if (args.firstPrompt?.payload_summary !== excerpt) {
    return { eligible: false, reason: "provenance_mismatch" };
  }
  return { eligible: true, body: excerpt };
}

// The v2 promote_t1 prompt: the v1 template minus the "Memory kind" line,
// which named an action type rather than a memory kind.
export function renderP1PromptBlock({ body }: { body: string }): string {
  return `${DREAMING_JUDGE_PROMPT_PREAMBLE}
Memory body:
${body}

${DREAMING_JUDGE_PROMPT_OUTPUT}`.trim();
}
