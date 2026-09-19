import { resolveRoleLlmCandidates } from "@penumbra/core";
import { readFileSync } from "node:fs";

import type { JudgePool, JudgeVote } from "./judge-pool.js";

import { loadAgentChatConfig, resolveAgentChatConfigPath } from "../agentchat-config.js";
import { DEFAULT_DREAMING_AUTO_PROMOTE_MIN_JUDGES } from "./config.js";

// Shared helper approach was considered but deferred: t2-judge-pool returns
// T2MemoryExtraction[] while dreaming returns DreamingVoteRaw — the generic
// shape would need a <T> parameter that adds complexity without saving many
// lines. The fetch pattern is copied instead (same 20-line block in both
// places), which is the cleaner trade-off for V1.

export interface DreamingJudgeEntry {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  caPath?: string;
  requestExtras?: Record<string, unknown>;
}

type DreamingJudgeState = DreamingJudgeEntry & { caPem?: string };

interface DreamingVoteRaw {
  promote: boolean;
  confidence: number;
  rationale: string;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

export function buildDreamingPromptBlock({ body, kind }: { body: string; kind: string }): string {
  return `You are a memory quality judge deciding whether a candidate memory record should be promoted to long-term storage.

Return promote: false when the content is ephemeral: one-time observations ("X passed", "task #5 created"), session-specific events, literal system/dispatch prompts ("You are X, a long-lived agent...", "# Operating rules", "IMPLEMENTER MODE"), or anything that won't be true in 30 days. Return promote: true ONLY for durable knowledge: design decisions, project facts, user preferences, conventions, rules, debugging findings, gotchas, traps.
Memory kind: ${kind}
Memory body:
${body}

Output ONLY valid JSON — no prose, no code fences, no wrapper tags:
{"promote": <boolean>, "confidence": <number 0.0-1.0>, "rationale": "<one sentence>"}`.trim();
}

// Unreadable values stay 0 for now; a later task turns them into an
// abstention together with the retry cap.
function parseConfidence(value: unknown): number {
  let numeric = Number.NaN;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && value.trim() !== "") numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric));
}

export function parseDreamingJudgeResponse(content: string): DreamingVoteRaw {
  try {
    const stripped = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```[\s\S]*$/, "")
      .trim();
    const match = /\{[\s\S]*\}/.exec(stripped);
    if (!match) throw new Error("no_json_object");
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      promote: Boolean(parsed.promote),
      confidence: parseConfidence(parsed.confidence),
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    };
  } catch {
    return { promote: false, confidence: 0, rationale: "parse_error" };
  }
}

export class DreamingJudgeHttpError extends Error {
  readonly status: number;
  constructor(judgeName: string, status: number, detail: string) {
    super(`dreaming judge ${judgeName} returned ${String(status)}: ${detail}`);
    this.name = "DreamingJudgeHttpError";
    this.status = status;
  }
}

// The loggable, persistable class of a judge failure: never the message.
export function classifyDreamingJudgeError(err: unknown): string {
  if (err instanceof DreamingJudgeHttpError) return `http_${String(err.status)}`;
  if (err instanceof SyntaxError) return "invalid_response";
  return "transport_error";
}

class DreamingJudgePoolImpl implements JudgePool {
  private readonly judges: DreamingJudgeState[];
  private readonly fetchImpl: typeof fetch;
  private nextIndex = 0;

  constructor(judges: DreamingJudgeEntry[], fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.judges = judges.map((j) => ({
      ...j,
      caPem: j.caPath ? readFileSync(j.caPath, "utf8") : undefined,
    }));
  }

  judgeCount(): number {
    return this.judges.length;
  }

  private async callJudge(judge: DreamingJudgeState, prompt: string): Promise<DreamingVoteRaw> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (judge.apiKey) headers["Authorization"] = `Bearer ${judge.apiKey}`;
    const trimmed = judge.baseUrl.replace(/\/+$/, "");
    const url = trimmed.endsWith("/v1")
      ? `${trimmed}/chat/completions`
      : `${trimmed}/v1/chat/completions`;
    const init: RequestInit & { tls?: { ca: string } } = {
      method: "POST",
      headers,
      body: JSON.stringify({
        // Extras are spread FIRST so the canonical fields below always win.
        // The judge contract is owned by this code, not by agents.yaml: a
        // typo'd or hostile seat must not be able to rewrite the model,
        // the prompt, the response format, the budget, or determinism.
        ...(judge.requestExtras ?? {}),
        model: judge.model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 256,
        temperature: 0,
      }),
    };
    if (judge.caPem) init.tls = { ca: judge.caPem };
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      throw new DreamingJudgeHttpError(judge.name, res.status, await res.text());
    }
    const json = (await res.json()) as ChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content ?? "";
    return parseDreamingJudgeResponse(content);
  }

  async judge(args: {
    body: string;
    kind: "promote_t1" | "link" | "retire" | "rewrite";
  }): Promise<{ confidence: number; verdict: "yes" | "no" | "unsure"; rationale?: string }> {
    const prompt = buildDreamingPromptBlock(args);
    const judgeCount = this.judges.length;
    if (judgeCount === 0) {
      throw new Error("dreaming judge pool has no configured judges");
    }
    const idx = this.nextIndex % judgeCount;
    this.nextIndex = (idx + 1) % judgeCount;
    const judge = this.judges[idx];
    if (!judge) {
      throw new Error("dreaming judge pool index out of range");
    }
    const raw = await this.callJudge(judge, prompt);
    return {
      confidence: raw.confidence,
      verdict: raw.promote ? "yes" : "no",
      rationale: raw.rationale,
    };
  }

  async judgeAll(args: {
    body: string;
    kind: "promote_t1" | "link" | "retire" | "rewrite";
  }): Promise<JudgeVote[]> {
    const prompt = buildDreamingPromptBlock(args);
    return await Promise.all(
      this.judges.map(async (judge): Promise<JudgeVote> => {
        try {
          const raw = await this.callJudge(judge, prompt);
          return {
            promote: raw.promote,
            confidence: raw.confidence,
            rationale: raw.rationale,
            seat: judge.name,
          };
        } catch (err) {
          // An unreachable judge abstains — it must not count as a NO vote
          // in the quorum denominator.
          return {
            promote: false,
            confidence: 0,
            rationale: "judge_error",
            abstained: true,
            seat: judge.name,
            error_class: classifyDreamingJudgeError(err),
          };
        }
      }),
    );
  }
}

export function createDreamingJudgePool(
  judges: DreamingJudgeEntry[],
  fetchImpl?: typeof fetch,
): JudgePool {
  return new DreamingJudgePoolImpl(judges, fetchImpl);
}

// Accept only a real plain object. Anything else (string, number, array,
// null, class instance) is ignored rather than thrown on, so one malformed
// seat degrades to today's behaviour instead of failing the whole pool.
function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

export function createDreamingJudgePoolFromAgentchat(
  services?: { log?: { warn: (...a: unknown[]) => void } },
  fetchImpl?: typeof fetch,
): JudgePool | null {
  const configDir = resolveAgentChatConfigPath();
  let cfg;
  try {
    cfg = loadAgentChatConfig();
  } catch (err) {
    services?.log?.warn(
      { err, configDir },
      "dreaming: failed to load agentchat config for judge pool",
    );
    return null;
  }

  const roleTag = process.env["PENUMBRA_DREAMING_JUDGE_ROLE"] ?? "dreaming-judge";
  const candidates = resolveRoleLlmCandidates({ roleTag, agentchatConfig: cfg });

  // Require ≥2 agents: P1 auto-promote threshold is ceil(total*2/3) with
  // autoPromoteMinJudges=2 — a single judge can never reach quorum.
  if (candidates.length < DEFAULT_DREAMING_AUTO_PROMOTE_MIN_JUDGES) return null;

  const judges: DreamingJudgeEntry[] = candidates.map((candidate) => {
    const requestExtras = asPlainObject(candidate.options?.["requestExtras"]);
    return {
      name: candidate.name,
      baseUrl: candidate.baseUrl,
      apiKey: candidate.auth.source === "bearer" ? candidate.auth.token : "",
      model: candidate.model,
      caPath: candidate.caPath,
      ...(requestExtras ? { requestExtras } : {}),
    };
  });

  if (judges.length < DEFAULT_DREAMING_AUTO_PROMOTE_MIN_JUDGES) return null;

  return new DreamingJudgePoolImpl(judges, fetchImpl);
}
