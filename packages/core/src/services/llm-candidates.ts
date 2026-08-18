import { execFileSync } from "node:child_process";

export const ALLOWED_LLM_PROVIDERS = ["local", "nvidia-nim", "sakana"] as const;

export type LlmProvider = (typeof ALLOWED_LLM_PROVIDERS)[number];
export type LlmPurpose = "generation" | "embedding";

export type LlmAuthSource =
  | { source: "none" }
  | { source: "bearer"; token: string }
  | { source: "keychain"; service: string; account: string };

export interface LlmCandidate {
  name: string;
  baseUrl: string;
  model: string;
  provider: string;
  auth: LlmAuthSource;
}

export interface LlmRoutingBias {
  scope: "provider" | "agent";
  value: string;
  mode: "boost" | "divert" | "exclude";
  expires_at: string;
}

export interface ResolvedLlmCandidate extends LlmCandidate {
  provider: LlmProvider;
  tier: "primary" | "fallback";
}

export interface LlmServingCandidate {
  name: string;
  baseUrl: string;
  model: string;
  provider: LlmProvider;
  authSource: LlmAuthSource["source"];
  tier: "primary" | "fallback";
}

export interface ResolveLlmCandidatesInput {
  candidates: LlmCandidate[];
  purpose: LlmPurpose;
  activeBiases?: LlmRoutingBias[];
  now?: Date;
}

export interface LlmCandidateFailure<E> {
  candidate: ResolvedLlmCandidate;
  error: E;
}

export type LlmCandidateAttemptResult<T, E> =
  | {
      ok: true;
      value: T;
      candidate: ResolvedLlmCandidate;
      failures: LlmCandidateFailure<E>[];
    }
  | { ok: false; failures: LlmCandidateFailure<E>[] };

export type ResolveKeychainSecret = (service: string, account: string) => string;

const ALLOWED_PROVIDER_SET = new Set<string>(ALLOWED_LLM_PROVIDERS);

export function resolveLlmCandidates(input: ResolveLlmCandidatesInput): ResolvedLlmCandidate[] {
  if (input.candidates.length === 0) {
    throw new Error("no LLM candidates configured");
  }
  if (input.purpose === "embedding" && input.candidates.length > 1) {
    throw new Error("embedding fallback candidates are forbidden");
  }

  const resolved = input.candidates.map((candidate, index): ResolvedLlmCandidate => {
    if (!ALLOWED_PROVIDER_SET.has(candidate.provider)) {
      throw new Error(`LLM provider '${candidate.provider}' is not allowed`);
    }
    return {
      ...candidate,
      provider: candidate.provider as LlmProvider,
      tier: index === 0 ? "primary" : "fallback",
    };
  });

  const nowMs = (input.now ?? new Date()).getTime();
  const activeExclusions = (input.activeBiases ?? []).filter(
    (bias) => bias.mode === "exclude" && Date.parse(bias.expires_at) > nowMs,
  );
  const eligible = resolved.filter(
    (candidate) =>
      !activeExclusions.some(
        (bias) =>
          (bias.scope === "provider" && bias.value === candidate.provider) ||
          (bias.scope === "agent" && bias.value === candidate.name),
      ),
  );
  if (eligible.length === 0) {
    throw new Error("no eligible LLM candidate remains after routing biases");
  }
  return eligible;
}

export function resolveLlmProvider(baseUrl: string, explicitProvider?: string): LlmProvider {
  if (explicitProvider !== undefined && explicitProvider !== "") {
    if (!ALLOWED_PROVIDER_SET.has(explicitProvider)) {
      throw new Error(`LLM provider '${explicitProvider}' is not allowed`);
    }
    return explicitProvider as LlmProvider;
  }

  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`cannot resolve LLM provider from invalid base URL '${baseUrl}'`);
  }
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  ) {
    return "local";
  }
  if (hostname === "integrate.api.nvidia.com") return "nvidia-nim";
  if (hostname === "sakana.ai" || hostname.endsWith(".sakana.ai")) return "sakana";
  throw new Error(`LLM provider is required for unrecognized host '${hostname}'`);
}

export async function attemptLlmCandidates<T, E>(
  candidates: ResolvedLlmCandidate[],
  attempt: (
    candidate: ResolvedLlmCandidate,
  ) => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
): Promise<LlmCandidateAttemptResult<T, E>> {
  return attemptCandidatesInOrder(candidates, attempt);
}

export async function attemptCandidatesInOrder<C, T, E>(
  candidates: C[],
  attempt: (candidate: C) => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
): Promise<
  | { ok: true; value: T; candidate: C; failures: { candidate: C; error: E }[] }
  | { ok: false; failures: { candidate: C; error: E }[] }
> {
  const failures: { candidate: C; error: E }[] = [];
  for (const candidate of candidates) {
    const result = await attempt(candidate);
    if (result.ok) {
      return { ok: true, value: result.value, candidate, failures };
    }
    failures.push({ candidate, error: result.error });
  }
  return { ok: false, failures };
}

export function describeLlmCandidate(candidate: ResolvedLlmCandidate): LlmServingCandidate {
  return {
    name: candidate.name,
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    provider: candidate.provider,
    authSource: candidate.auth.source,
    tier: candidate.tier,
  };
}

export function resolveLlmAuthorization(
  candidate: LlmCandidate,
  resolveKeychain: ResolveKeychainSecret = defaultResolveKeychainSecret,
): string | null {
  if (candidate.auth.source === "none") return null;
  if (candidate.auth.source === "bearer") return candidate.auth.token;
  return resolveKeychain(candidate.auth.service, candidate.auth.account).trim();
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

export function createNvidiaNimFallbackCandidate(): LlmCandidate {
  return {
    name: "nvidia-nim-llama-3.1-8b-instruct",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.1-8b-instruct",
    provider: "nvidia-nim",
    auth: { source: "keychain", service: "llamactl", account: "nvidia" },
  };
}

function defaultResolveKeychainSecret(service: string, account: string): string {
  return execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
