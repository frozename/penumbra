import { readFileSync } from 'node:fs';
import { loadAgentChatConfig, resolveAgentChatConfigPath } from '../agentchat-config.js';
import type { JudgePool, JudgeVote } from './judge-pool.js';

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
}

type DreamingJudgeState = DreamingJudgeEntry & { caPem?: string };

interface DreamingVoteRaw {
  promote: boolean;
  confidence: number;
  rationale: string;
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

export function parseDreamingJudgeResponse(content: string): DreamingVoteRaw {
  try {
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no_json_object');
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      promote: Boolean(parsed.promote),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  } catch {
    return { promote: false, confidence: 0, rationale: 'parse_error' };
  }
}

class DreamingJudgePoolImpl implements JudgePool {
  private readonly judges: DreamingJudgeState[];
  private readonly fetchImpl: typeof fetch;
  private nextIndex = 0;

  constructor(judges: DreamingJudgeEntry[], fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.judges = judges.map((j) => ({
      ...j,
      caPem: j.caPath ? readFileSync(j.caPath, 'utf8') : undefined,
    }));
  }

  judgeCount(): number {
    return this.judges.length;
  }

  private async callJudge(judge: DreamingJudgeState, prompt: string): Promise<DreamingVoteRaw> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (judge.apiKey) headers['Authorization'] = `Bearer ${judge.apiKey}`;
    const trimmed = judge.baseUrl.replace(/\/+$/, '');
    const url = trimmed.endsWith('/v1') ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
    const init: RequestInit & { tls?: { ca: string } } = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: judge.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 256,
        temperature: 0,
      }),
    };
    if (judge.caPem) (init as any).tls = { ca: judge.caPem };
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      throw new Error(`dreaming judge ${judge.name} returned ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as any;
    const content: string = json.choices?.[0]?.message?.content ?? '';
    return parseDreamingJudgeResponse(content);
  }

  async judge(args: {
    body: string;
    kind: 'promote_t1' | 'link' | 'retire' | 'rewrite';
  }): Promise<{ confidence: number; verdict: 'yes' | 'no' | 'unsure'; rationale?: string }> {
    const prompt = buildDreamingPromptBlock(args);
    const idx = this.nextIndex % this.judges.length;
    this.nextIndex = (idx + 1) % this.judges.length;
    const judge = this.judges[idx]!;
    const raw = await this.callJudge(judge, prompt);
    return {
      confidence: raw.confidence,
      verdict: raw.promote ? 'yes' : 'no',
      rationale: raw.rationale,
    };
  }

  async judgeAll(args: {
    body: string;
    kind: 'promote_t1' | 'link' | 'retire' | 'rewrite';
  }): Promise<JudgeVote[]> {
    const prompt = buildDreamingPromptBlock(args);
    return Promise.all(
      this.judges.map(async (judge): Promise<JudgeVote> => {
        try {
          const raw = await this.callJudge(judge, prompt);
          return { promote: raw.promote, confidence: raw.confidence, rationale: raw.rationale };
        } catch {
          return { promote: false, confidence: 0, rationale: 'judge_error' };
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

export function createDreamingJudgePoolFromAgentchat(
  services?: { log?: { warn: (...a: unknown[]) => void } },
  fetchImpl?: typeof fetch,
): JudgePool | null {
  const configDir = resolveAgentChatConfigPath();
  let cfg;
  try {
    cfg = loadAgentChatConfig();
  } catch (err) {
    services?.log?.warn({ err, configDir }, 'dreaming: failed to load agentchat config for judge pool');
    return null;
  }

  const roleTag = process.env['PENUMBRA_DREAMING_JUDGE_ROLE'] ?? 'dreaming-judge';
  const eligible = (cfg.agents ?? []).filter(
    (agent) =>
      agent.adapter === 'openai-compat-http' &&
      Array.isArray(agent.roles) &&
      agent.roles.includes(roleTag) &&
      typeof agent.options?.['baseUrl'] === 'string' &&
      (agent.options['baseUrl'] as string).length > 0,
  );

  // Require ≥2 agents: P1 auto-promote threshold is ceil(total*2/3) with
  // autoPromoteMinJudges=2 — a single judge can never reach quorum.
  if (eligible.length < 2) return null;

  const judges: DreamingJudgeEntry[] = eligible.map((agent) => ({
    name: agent.name,
    baseUrl: agent.options['baseUrl'] as string,
    apiKey: (agent.options['apiKey'] as string | undefined) ?? '',
    model: (agent.options['model'] as string | undefined) ?? 'local',
    caPath: agent.options['caPath'] as string | undefined,
  }));

  return new DreamingJudgePoolImpl(judges, fetchImpl);
}
