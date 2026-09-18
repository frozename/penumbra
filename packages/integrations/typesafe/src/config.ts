import { parseKeychainRef, resolveAuthSecret, type ResolveKeychainSecret } from "@penumbra/core";

export type TypesafeJudgePromotionMode = "off" | "shadow";

/** The parsed PENUMBRA_TYPESAFE_* subset of the env registry. Dot access keeps every token visible to completeness.test.ts. */
export interface TypesafeEnvInput {
  readonly PENUMBRA_TYPESAFE_API_KEY?: string | undefined;
  readonly PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN?: string | undefined;
  readonly PENUMBRA_TYPESAFE_BASE_URL: string;
  readonly PENUMBRA_TYPESAFE_MODEL: string;
  readonly PENUMBRA_TYPESAFE_TIMEOUT_MS: number;
  readonly PENUMBRA_TYPESAFE_JUDGE_PROMOTION: TypesafeJudgePromotionMode;
}

export type TypesafeDisabledReason =
  | "judge_promotion_off"
  | "invalid_base_url"
  | "model_not_versioned"
  | "no_key"
  | "invalid_keychain_ref"
  | "keychain_unavailable"
  | "empty_key";

export type TypesafeSettings =
  | {
      enabled: true;
      apiKey: string;
      keySource: "env" | "keychain";
      baseUrl: string;
      model: string;
      timeoutMs: number;
      judgePromotion: TypesafeJudgePromotionMode;
    }
  | {
      enabled: false;
      reason: TypesafeDisabledReason;
      judgePromotion: TypesafeJudgePromotionMode;
    };

const VERSIONED_MODEL = /^jev-\d+\.\d+\.\d+$/;

export function resolveTypesafeSettings(
  env: TypesafeEnvInput,
  deps?: { resolveKeychain?: ResolveKeychainSecret },
): TypesafeSettings {
  const disabled = (reason: TypesafeDisabledReason): TypesafeSettings => ({
    enabled: false,
    reason,
    judgePromotion: env.PENUMBRA_TYPESAFE_JUDGE_PROMOTION,
  });
  const enabled = (apiKey: string, keySource: "env" | "keychain"): TypesafeSettings => ({
    enabled: true,
    apiKey,
    keySource,
    baseUrl: env.PENUMBRA_TYPESAFE_BASE_URL,
    model: env.PENUMBRA_TYPESAFE_MODEL,
    timeoutMs: env.PENUMBRA_TYPESAFE_TIMEOUT_MS,
    judgePromotion: env.PENUMBRA_TYPESAFE_JUDGE_PROMOTION,
  });

  if (env.PENUMBRA_TYPESAFE_JUDGE_PROMOTION === "off") return disabled("judge_promotion_off");

  let baseUrl: URL;
  try {
    baseUrl = new URL(env.PENUMBRA_TYPESAFE_BASE_URL);
  } catch {
    return disabled("invalid_base_url");
  }
  if (baseUrl.protocol !== "https:") return disabled("invalid_base_url");

  if (!VERSIONED_MODEL.test(env.PENUMBRA_TYPESAFE_MODEL)) {
    return disabled("model_not_versioned");
  }

  const envKey = env.PENUMBRA_TYPESAFE_API_KEY?.trim();
  if (envKey) return enabled(envKey, "env");

  const refRaw = env.PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN?.trim();
  if (!refRaw) return disabled("no_key");
  const ref = parseKeychainRef(refRaw);
  if (!ref) return disabled("invalid_keychain_ref");

  let apiKey: string | null;
  try {
    apiKey = resolveAuthSecret(
      { source: "keychain", service: ref.service, account: ref.account },
      deps?.resolveKeychain,
    );
  } catch {
    return disabled("keychain_unavailable");
  }
  if (!apiKey) return disabled("empty_key");
  return enabled(apiKey, "keychain");
}
