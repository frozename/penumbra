import { readFileSync } from "node:fs";

import {
  attemptCandidatesInOrder,
  resolveRoleLlmCandidates,
} from "../../../core/src/services/llm-candidates.js";

import { loadAgentChatConfig, resolveAgentChatConfigPath } from "../agentchat-config.js";

export interface BriefSynthesizerInput {
  project_id: string;
  recent_memories: {
    memory_id: string;
    kind: string;
    title: string;
    body: string;
    created_at: string;
  }[];
  prior_brief?: string;
}

export interface BriefSynthesizer {
  synthesize(
    input: BriefSynthesizerInput,
  ): Promise<{ markdown: string; source_memory_ids: string[] }>;
}

interface BriefSynthesizerEntry {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  caPath?: string;
}

type BriefSynthesizerState = BriefSynthesizerEntry & { caPem?: string };

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

export function buildBriefPrompt(input: BriefSynthesizerInput): string {
  const memorySection = input.recent_memories
    .map((m, i) => `### Memory ${String(i + 1)} [${m.kind}] — ${m.title}\n${m.body}`)
    .join("\n\n");

  const priorSection = input.prior_brief
    ? `\n\n## Prior Brief (for continuity — do not duplicate verbatim)\n\n${input.prior_brief}`
    : "";

  return `You are a project knowledge synthesizer. Produce a concise markdown brief for the project described below.

Project ID: ${input.project_id}

## Recent Memories (newest first)

${memorySection}${priorSection}

## Instructions

Write a markdown brief titled exactly: # Project Brief: ${input.project_id}

Rules:
- Summarize the most important findings from the recent memories above.
- If a prior brief is provided, reference it for continuity but do not duplicate it verbatim.
- Call out explicitly anything that has changed or is currently in-flight.
- Keep total length under 2000 tokens.
- Output plain markdown only — no code fences, no wrapper tags.`.trim();
}

export function parseSynthesizerResponse(content: string): string {
  let s = content.trim();
  s = s.replace(/^```(?:[a-zA-Z]*)?\s*\n?/, "");
  s = s.replace(/\n?```\s*$/, "");
  return s.trim();
}

class BriefSynthesizerImpl implements BriefSynthesizer {
  private readonly agents: BriefSynthesizerState[];
  private readonly fetchImpl: typeof fetch;
  private nextIndex = 0;

  constructor(agents: BriefSynthesizerEntry[], fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.agents = agents.map((a) => ({
      ...a,
      caPem: a.caPath ? readFileSync(a.caPath, "utf8") : undefined,
    }));
  }

  private async callAgent(agent: BriefSynthesizerState, prompt: string): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (agent.apiKey) headers["Authorization"] = `Bearer ${agent.apiKey}`;
    const trimmed = agent.baseUrl.replace(/\/+$/, "");
    const url = trimmed.endsWith("/v1")
      ? `${trimmed}/chat/completions`
      : `${trimmed}/v1/chat/completions`;
    const init: RequestInit & { tls?: { ca: string } } = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: agent.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
        temperature: 0.3,
      }),
    };
    if (agent.caPem) init.tls = { ca: agent.caPem };
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      throw new Error(
        `brief synthesizer ${agent.name} returned ${String(res.status)}: ${await res.text()}`,
      );
    }
    const json = (await res.json()) as ChatCompletionResponse;
    const rawContent = json.choices?.[0]?.message?.content ?? "";
    return parseSynthesizerResponse(rawContent);
  }

  async synthesize(
    input: BriefSynthesizerInput,
  ): Promise<{ markdown: string; source_memory_ids: string[] }> {
    const agentCount = this.agents.length;
    if (agentCount === 0) {
      throw new Error("brief synthesizer has no configured agents");
    }
    const prompt = buildBriefPrompt(input);
    const start = this.nextIndex % agentCount;
    this.nextIndex = (start + 1) % agentCount;
    // Try the round-robin pick first, then fail over to the remaining agents in
    // order. A single down seat (e.g. an unreachable local MLX endpoint) must not
    // degrade the brief to a stub when a healthy sibling is one retry away — only
    // throw (caller falls back to stub) when EVERY seat fails.
    const orderedAgents = Array.from(
      { length: agentCount },
      (_, index) => this.agents[(start + index) % agentCount],
    ).filter((agent): agent is BriefSynthesizerState => agent !== undefined);
    const attempted = await attemptCandidatesInOrder(orderedAgents, async (agent) => {
      try {
        return { ok: true as const, value: await this.callAgent(agent, prompt) };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    if (attempted.ok) {
      return {
        markdown: attempted.value,
        source_memory_ids: input.recent_memories.map((m) => m.memory_id),
      };
    }
    const errors = attempted.failures.map(
      ({ candidate, error }) =>
        `${candidate.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new Error(`all brief synthesizer agents failed: ${errors.join("; ")}`);
  }
}

export function createBriefSynthesizer(
  agents: BriefSynthesizerEntry[],
  fetchImpl?: typeof fetch,
): BriefSynthesizer {
  return new BriefSynthesizerImpl(agents, fetchImpl);
}

export function createBriefSynthesizerFromAgentchat(
  services?: { log?: { warn: (...a: unknown[]) => void } },
  fetchImpl?: typeof fetch,
): BriefSynthesizer | null {
  const configDir = resolveAgentChatConfigPath();
  let cfg;
  try {
    cfg = loadAgentChatConfig();
  } catch (err) {
    services?.log?.warn(
      { err, configDir },
      "dreaming: failed to load agentchat config for brief synthesizer",
    );
    return null;
  }

  const roleTag = process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE"] ?? "brief-synthesizer";
  let candidates;
  try {
    candidates = resolveRoleLlmCandidates({ roleTag, agentchatConfig: cfg });
  } catch (err) {
    services?.log?.warn({ err }, "dreaming: brief synthesizer role has no allowed LLM candidates");
    return null;
  }
  const agents: BriefSynthesizerEntry[] = candidates
    .filter((candidate) => isAllowedBriefSynthesizerHttpCandidate(candidate))
    .map((candidate) => ({
      name: candidate.name,
      baseUrl: candidate.baseUrl,
      apiKey: candidate.auth.source === "bearer" ? candidate.auth.token : "",
      model: candidate.model,
      caPath: candidate.caPath,
    }));

  if (agents.length === 0) return null;

  return new BriefSynthesizerImpl(agents, fetchImpl);
}

function isAllowedBriefSynthesizerHttpCandidate(candidate: {
  baseUrl: string;
  provider: string;
}): boolean {
  if (candidate.provider === "local" || candidate.provider === "sakana") return true;
  try {
    const hostname = new URL(candidate.baseUrl).hostname.toLowerCase();
    return !hostname.includes(".");
  } catch {
    return false;
  }
}
