import { readFileSync } from "node:fs";
import { loadAgentChatConfig, resolveAgentChatConfigPath } from "../agentchat-config.js";

export interface BriefSynthesizerInput {
  project_id: string;
  recent_memories: Array<{
    memory_id: string;
    kind: string;
    title: string;
    body: string;
    created_at: string;
  }>;
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

const PUBLIC_API_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
];

function isPublicEndpoint(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl.replace(/\/+$/, ""));
    return PUBLIC_API_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch {
    return false;
  }
}

export function buildBriefPrompt(input: BriefSynthesizerInput): string {
  const memorySection = input.recent_memories
    .map((m, i) => `### Memory ${i + 1} [${m.kind}] — ${m.title}\n${m.body}`)
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
    if (agent.caPem) (init as any).tls = { ca: agent.caPem };
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      throw new Error(
        `brief synthesizer ${agent.name} returned ${res.status}: ${await res.text()}`,
      );
    }
    const json = (await res.json()) as any;
    const rawContent: string = json.choices?.[0]?.message?.content ?? "";
    return parseSynthesizerResponse(rawContent);
  }

  async synthesize(
    input: BriefSynthesizerInput,
  ): Promise<{ markdown: string; source_memory_ids: string[] }> {
    const prompt = buildBriefPrompt(input);
    const idx = this.nextIndex % this.agents.length;
    this.nextIndex = (idx + 1) % this.agents.length;
    const agent = this.agents[idx]!;
    const markdown = await this.callAgent(agent, prompt);
    return {
      markdown,
      source_memory_ids: input.recent_memories.map((m) => m.memory_id),
    };
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
    services?.log?.warn?.(
      { err, configDir },
      "dreaming: failed to load agentchat config for brief synthesizer",
    );
    return null;
  }

  const roleTag = process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ROLE"] ?? "brief-synthesizer";
  const eligible = (cfg.agents ?? []).filter(
    (agent) =>
      agent.adapter === "openai-compat-http" &&
      Array.isArray(agent.roles) &&
      agent.roles.includes(roleTag) &&
      typeof agent.options?.["baseUrl"] === "string" &&
      (agent.options["baseUrl"] as string).length > 0,
  );

  if (eligible.length === 0) return null;

  const allowPublic = process.env["PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC"] === "1";
  const agents: BriefSynthesizerEntry[] = [];
  for (const agent of eligible) {
    const baseUrl = agent.options["baseUrl"] as string;
    if (isPublicEndpoint(baseUrl) && !allowPublic) {
      services?.log?.warn?.(
        { agent: agent.name, baseUrl },
        "dreaming: brief synthesizer endpoint is a public API — skipping to protect memory privacy. Set PENUMBRA_DREAMING_BRIEF_SYNTHESIZER_ALLOW_PUBLIC=1 to override.",
      );
      continue;
    }
    agents.push({
      name: agent.name,
      baseUrl,
      apiKey: (agent.options["apiKey"] as string | undefined) ?? "",
      model: (agent.options["model"] as string | undefined) ?? "local",
      caPath: agent.options["caPath"] as string | undefined,
    });
  }

  if (agents.length === 0) return null;

  return new BriefSynthesizerImpl(agents, fetchImpl);
}
