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
}): JudgeChatFn {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? resolveJudgeChatTimeoutMs();
  return async (chatOpts) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (opts.token) {
        headers.authorization = `Bearer ${opts.token}`;
      }
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: chatOpts.model,
          messages: chatOpts.messages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`judge chat: timed out after ${String(timeoutMs)}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`judge chat: HTTP ${String(res.status)}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("judge chat: empty response");
    }
    return content;
  };
}

const DEFAULT_JUDGE_BASE_URL = "http://127.0.0.1:7944";
const DEFAULT_JUDGE_MODEL = "local";

export interface ResolvedJudgeConfig {
  baseUrl: string;
  model: string;
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

  return {
    baseUrl,
    model,
    token,
    usedDefaultBaseUrl: !baseUrlSources.some((v) => !!v),
    usedDefaultModel: !modelFromEnv,
  };
}
