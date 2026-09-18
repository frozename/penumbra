import { expect, test } from "bun:test";

import type { TypesafeEnvInput } from "../src/index.js";

import * as typesafe from "../src/index.js";

const base = {
  PENUMBRA_TYPESAFE_BASE_URL: "https://api.typesafe.ai",
  PENUMBRA_TYPESAFE_MODEL: "jev-1.13.0",
  PENUMBRA_TYPESAFE_TIMEOUT_MS: 10000,
  PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "shadow",
} satisfies TypesafeEnvInput;

function keychainSpy(impl: () => string): {
  calls: [string, string][];
  resolveKeychain: (service: string, account: string) => string;
} {
  const calls: [string, string][] = [];
  const resolveKeychain = (service: string, account: string): string => {
    calls.push([service, account]);
    return impl();
  };
  return { calls, resolveKeychain };
}

test("env key wins over the keychain ref without touching the keychain", () => {
  expect(typeof typesafe.resolveTypesafeSettings).toBe("function");
  const keychain = keychainSpy(() => "k-chain");
  const settings = typesafe.resolveTypesafeSettings(
    {
      ...base,
      PENUMBRA_TYPESAFE_API_KEY: "k-env",
      PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: "llamactl/typesafe",
    },
    { resolveKeychain: keychain.resolveKeychain },
  );
  expect(settings).toEqual({
    enabled: true,
    apiKey: "k-env",
    keySource: "env",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-1.13.0",
    timeoutMs: 10000,
    judgePromotion: "shadow",
  });
  expect(keychain.calls).toEqual([]);
});

test("keychain ref resolves through the injected resolver when env key is absent", () => {
  const keychain = keychainSpy(() => "k-chain\n");
  const settings = typesafe.resolveTypesafeSettings(
    { ...base, PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: "llamactl/typesafe" },
    { resolveKeychain: keychain.resolveKeychain },
  );
  expect(settings).toEqual({
    enabled: true,
    apiKey: "k-chain",
    keySource: "keychain",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-1.13.0",
    timeoutMs: 10000,
    judgePromotion: "shadow",
  });
  expect(keychain.calls).toEqual([["llamactl", "typesafe"]]);
});

test("whitespace-only env key is treated as unset and falls through to the keychain", () => {
  const keychain = keychainSpy(() => "k-chain");
  const settings = typesafe.resolveTypesafeSettings(
    {
      ...base,
      PENUMBRA_TYPESAFE_API_KEY: "  ",
      PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: "llamactl/typesafe",
    },
    { resolveKeychain: keychain.resolveKeychain },
  );
  expect(settings).toMatchObject({ enabled: true, apiKey: "k-chain", keySource: "keychain" });
  expect(keychain.calls).toEqual([["llamactl", "typesafe"]]);
});

test("malformed keychain ref disables the judge without calling the keychain", () => {
  const keychain = keychainSpy(() => "k-chain");
  const settings = typesafe.resolveTypesafeSettings(
    { ...base, PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: "llamactl/" },
    { resolveKeychain: keychain.resolveKeychain },
  );
  expect(settings).toEqual({
    enabled: false,
    reason: "invalid_keychain_ref",
    judgePromotion: "shadow",
  });
  expect(keychain.calls).toEqual([]);
});

test("keychain resolver failure disables the judge instead of throwing", () => {
  const keychain = keychainSpy(() => {
    throw new Error("security: the specified item could not be found");
  });
  const settings = typesafe.resolveTypesafeSettings(
    { ...base, PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: "llamactl/typesafe" },
    { resolveKeychain: keychain.resolveKeychain },
  );
  expect(settings).toEqual({
    enabled: false,
    reason: "keychain_unavailable",
    judgePromotion: "shadow",
  });
});

test("empty keychain secret fails closed so a blank key never yields a 401ing client", () => {
  const keychain = keychainSpy(() => " \n");
  const settings = typesafe.resolveTypesafeSettings(
    { ...base, PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: "llamactl/typesafe" },
    { resolveKeychain: keychain.resolveKeychain },
  );
  expect(settings).toEqual({ enabled: false, reason: "empty_key", judgePromotion: "shadow" });
  expect(keychain.calls).toEqual([["llamactl", "typesafe"]]);
});

test("promotion off disables the judge before any keychain subprocess can spawn", () => {
  const keychain = keychainSpy(() => "k-chain");
  const settings = typesafe.resolveTypesafeSettings(
    {
      ...base,
      PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "off",
      PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: "llamactl/typesafe",
    },
    { resolveKeychain: keychain.resolveKeychain },
  );
  expect(settings).toEqual({
    enabled: false,
    reason: "judge_promotion_off",
    judgePromotion: "off",
  });
  expect(keychain.calls).toEqual([]);
});

test("non-versioned model and non-https base url disable the judge before key resolution", () => {
  const keychain = keychainSpy(() => "k-chain");
  const badModel = typesafe.resolveTypesafeSettings(
    {
      ...base,
      PENUMBRA_TYPESAFE_MODEL: "jev-latest",
      PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: "llamactl/typesafe",
    },
    { resolveKeychain: keychain.resolveKeychain },
  );
  expect(badModel).toEqual({
    enabled: false,
    reason: "model_not_versioned",
    judgePromotion: "shadow",
  });
  const badUrl = typesafe.resolveTypesafeSettings(
    {
      ...base,
      PENUMBRA_TYPESAFE_BASE_URL: "http://api.typesafe.ai",
      PENUMBRA_TYPESAFE_API_KEY_KEYCHAIN: "llamactl/typesafe",
    },
    { resolveKeychain: keychain.resolveKeychain },
  );
  expect(badUrl).toEqual({
    enabled: false,
    reason: "invalid_base_url",
    judgePromotion: "shadow",
  });
  expect(keychain.calls).toEqual([]);
});

test("missing env key and keychain ref reports no_key and ignores foreign properties", () => {
  const keychain = keychainSpy(() => "k-chain");
  const input = { ...base, TYPESAFE_API_KEY: "leak" } as TypesafeEnvInput;
  const settings = typesafe.resolveTypesafeSettings(input, {
    resolveKeychain: keychain.resolveKeychain,
  });
  expect(settings).toEqual({ enabled: false, reason: "no_key", judgePromotion: "shadow" });
  expect(keychain.calls).toEqual([]);
});
