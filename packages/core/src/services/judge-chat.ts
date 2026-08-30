import {
  attemptLlmCandidates,
  buildChatCompletionsUrl,
  describeLlmCandidate,
  type LlmAuthSource,
  type LlmCandidate,
  type LlmRoutingBias,
  type LlmServingCandidate,
  type ResolvedLlmCandidate,
  type ResolveKeychainSecret,
  resolveLlmAuthorization,
  resolveLlmCandidates,
  resolveLlmProvider,
} from "./llm-candidates.js";

export type JudgeChatFn = (opts: {
  messages: { role: string; content: string }[];
  model: string;
}) => Promise<string>;

export const DEFAULT_JUDGE_CHAT_TIMEOUT_MS = 30_000;

/**
 * Resolve the judge-chat HTTP timeout. The default suits a fast
 * classification judge (granite returns in seconds); a refiner that uses a
 * reasoning model (which emits a long chain-of-thought before the answer) can
 * legitimately need longer, so callers override per-instance (see serve.ts
 * threading PENUMBRA_REFINER_TIMEOUT_MS). PENUMBRA_JUDGE_TIMEOUT_MS overrides
 * the global default.
 */
export function resolveJudgeChatTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.PENUMBRA_JUDGE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_JUDGE_CHAT_TIMEOUT_MS;
}

export function createJudgeChat(opts: {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  provider?: string;
  auth?: LlmAuthSource;
  candidateName?: string;
  fallbackCandidates?: LlmCandidate[];
  activeBiases?: LlmRoutingBias[] | (() => LlmRoutingBias[]);
  now?: Date;
  fetchFn?: typeof fetch;
  resolveKeychain?: ResolveKeychainSecret;
  onOutcome?: (outcome: {
    ok: boolean;
    candidate: LlmServingCandidate;
    reason?: string;
    status?: number;
  }) => void;
}): JudgeChatFn {
  const timeoutMs = opts.timeoutMs ?? resolveJudgeChatTimeoutMs();
  return async (chatOpts) => {
    const candidates = resolveLlmCandidates({
      candidates: [
        {
          name: opts.candidateName ?? chatOpts.model,
          baseUrl: opts.baseUrl,
          model: chatOpts.model,
          provider: opts.provider ?? "local",
          auth:
            opts.auth ??
            (opts.token ? { source: "bearer", token: opts.token } : { source: "none" }),
        },
        ...(opts.fallbackCandidates ?? []),
      ],
      purpose: "generation",
      activeBiases:
        typeof opts.activeBiases === "function" ? opts.activeBiases() : opts.activeBiases,
      now: opts.now,
    });
    const attempted = await attemptLlmCandidates<string, Error & { status?: number }>(
      candidates,
      async (candidate) => {
        try {
          return {
            ok: true as const,
            value: await invokeJudgeCandidate(candidate, chatOpts.messages, {
              timeoutMs,
              fetchFn: opts.fetchFn,
              resolveKeychain: opts.resolveKeychain,
            }),
          };
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          return { ok: false as const, error: normalized };
        }
      },
    );
    if (attempted.ok) {
      opts.onOutcome?.({ ok: true, candidate: describeLlmCandidate(attempted.candidate) });
      return attempted.value;
    }
    const finalFailure = attempted.failures.at(-1);
    if (!finalFailure) throw new Error("judge chat: no candidate attempt was made");
    const candidate = describeLlmCandidate(finalFailure.candidate);
    opts.onOutcome?.({
      ok: false,
      candidate,
      reason: finalFailure.error.message,
      status: finalFailure.error.status,
    });
    if (attempted.failures.length === 1) throw finalFailure.error;
    throw new Error(
      `all judge chat candidates failed: ${attempted.failures
        .map((failure) => `${failure.candidate.name}: ${failure.error.message}`)
        .join("; ")}`,
    );
  };
}

async function invokeJudgeCandidate(
  candidate: ResolvedLlmCandidate,
  messages: { role: string; content: string }[],
  opts: {
    timeoutMs: number;
    fetchFn?: typeof fetch;
    resolveKeychain?: ResolveKeychainSecret;
  },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs);
  let res: Response;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const token = resolveLlmAuthorization(candidate, opts.resolveKeychain);
    if (token) headers.authorization = `Bearer ${token}`;
    res = await (opts.fetchFn ?? globalThis.fetch)(buildChatCompletionsUrl(candidate.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: candidate.model,
        messages,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`judge chat: timed out after ${String(opts.timeoutMs)}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const error = new Error(`judge chat: HTTP ${String(res.status)}`) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("judge chat: empty response");
  }
  return content;
}

const DEFAULT_JUDGE_BASE_URL = "http://127.0.0.1:7944";
const DEFAULT_JUDGE_MODEL = "local";

export interface ResolvedJudgeConfig {
  baseUrl: string;
  model: string;
  provider: string;
  token: string;
  usedDefaultBaseUrl: boolean;
  usedDefaultModel: boolean;
}

// Single source of truth for daemon judge/refiner endpoint resolution.
// Precedence keeps legacy PENUMBRA_SIRIUS_* and SIRIUS_URL working as
// back-compat fallbacks. `extraModelEnv` lets a caller (e.g. dispatch-refine)
// prepend higher-priority model env names like PENUMBRA_REFINER_MODEL.
export function resolveJudgeConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { extraModelEnv?: string[] } = {},
): ResolvedJudgeConfig {
  const baseUrlSources = [
    env.PENUMBRA_JUDGE_BASE_URL,
    env.PENUMBRA_SIRIUS_BASE_URL,
    env.SIRIUS_URL,
  ];
  const baseUrl = baseUrlSources.find((v) => !!v) ?? DEFAULT_JUDGE_BASE_URL;

  const modelEnvNames = [
    ...(opts.extraModelEnv ?? []),
    "PENUMBRA_JUDGE_MODEL",
    "PENUMBRA_SIRIUS_MODEL",
  ];
  let model = DEFAULT_JUDGE_MODEL;
  let modelFromEnv = false;
  for (const name of modelEnvNames) {
    const v = env[name];
    if (v) {
      model = v;
      modelFromEnv = true;
      break;
    }
  }

  const token = env.PENUMBRA_JUDGE_TOKEN ?? env.PENUMBRA_SIRIUS_TOKEN ?? "";
  const provider = resolveLlmProvider(baseUrl);

  return {
    baseUrl,
    model,
    provider,
    token,
    usedDefaultBaseUrl: !baseUrlSources.some((v) => !!v),
    usedDefaultModel: !modelFromEnv,
  };
}
