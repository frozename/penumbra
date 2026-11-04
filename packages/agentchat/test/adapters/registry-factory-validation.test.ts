import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAdapter,
  BUILT_IN_ADAPTER_KINDS,
  clearCustomAdapters,
  registerAdapter,
} from "@src/adapters/registry.js";
import type { Adapter } from "@src/sdk/adapter.js";

afterEach(() => {
  clearCustomAdapters();
});

test("buildAdapter rejects an unknown kind", () => {
  expect(() => buildAdapter("no-such-kind", {})).toThrow(/unknown adapter kind: no-such-kind/);
});

test("every built-in kind resolves to a factory that validates its own options", () => {
  for (const kind of BUILT_IN_ADAPTER_KINDS) {
    let thrown: Error | undefined;
    try {
      buildAdapter(kind, {});
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message.startsWith(`${kind}:`)).toBe(true);
    expect(thrown?.message ?? "").not.toMatch(/unknown adapter kind/);
  }
});

test("openai-compat-http requires baseUrl", () => {
  expect(() => buildAdapter("openai-compat-http", { model: "m", apiKey: "k" })).toThrow(
    /openai-compat-http: baseUrl is required/,
  );
});

test("openai-compat-http requires model", () => {
  expect(() => buildAdapter("openai-compat-http", { baseUrl: "http://x/v1", apiKey: "k" })).toThrow(
    /openai-compat-http: model is required/,
  );
});

test("openai-compat-http requires a key source", () => {
  expect(() => buildAdapter("openai-compat-http", { baseUrl: "http://x/v1", model: "m" })).toThrow(
    /one of apiKey \/ apiKeyEnv \/ apiKeyKeychain \/ apiKeyFile is required/,
  );
});

test("openai-compat-http treats an empty literal apiKey as no key source", () => {
  expect(() =>
    buildAdapter("openai-compat-http", { baseUrl: "http://x/v1", model: "m", apiKey: "" }),
  ).toThrow(/one of apiKey \/ apiKeyEnv \/ apiKeyKeychain \/ apiKeyFile is required/);
});

test("openai-compat-http forwards the legacy api_key_env alias as apiKeyEnv", () => {
  const NAME = "PENUMBRA_REGISTRY_TEST_UNSET_KEY_342";
  const original = process.env.PENUMBRA_REGISTRY_TEST_UNSET_KEY_342;
  delete process.env.PENUMBRA_REGISTRY_TEST_UNSET_KEY_342;
  try {
    expect(() =>
      buildAdapter("openai-compat-http", {
        baseUrl: "http://x/v1",
        model: "m",
        api_key_env: NAME,
      }),
    ).toThrow(new RegExp(`apiKeyEnv: env var ${NAME} is unset or empty`));
  } finally {
    if (original === undefined) {
      delete process.env.PENUMBRA_REGISTRY_TEST_UNSET_KEY_342;
    } else {
      process.env.PENUMBRA_REGISTRY_TEST_UNSET_KEY_342 = original;
    }
  }
});

test("openai-compat-http prefers apiKeyEnv over the api_key_env alias", () => {
  const A = "PENUMBRA_REGISTRY_TEST_CAMEL_KEY_342";
  const B = "PENUMBRA_REGISTRY_TEST_SNAKE_KEY_342";
  const originalA = process.env.PENUMBRA_REGISTRY_TEST_CAMEL_KEY_342;
  const originalB = process.env.PENUMBRA_REGISTRY_TEST_SNAKE_KEY_342;
  process.env.PENUMBRA_REGISTRY_TEST_CAMEL_KEY_342 = "from-camel";
  delete process.env.PENUMBRA_REGISTRY_TEST_SNAKE_KEY_342;
  try {
    expect(() =>
      buildAdapter("openai-compat-http", {
        baseUrl: "http://x/v1",
        model: "m",
        apiKeyEnv: A,
        api_key_env: B,
      }),
    ).not.toThrow();
  } finally {
    if (originalA === undefined) {
      delete process.env.PENUMBRA_REGISTRY_TEST_CAMEL_KEY_342;
    } else {
      process.env.PENUMBRA_REGISTRY_TEST_CAMEL_KEY_342 = originalA;
    }
    if (originalB === undefined) {
      delete process.env.PENUMBRA_REGISTRY_TEST_SNAKE_KEY_342;
    } else {
      process.env.PENUMBRA_REGISTRY_TEST_SNAKE_KEY_342 = originalB;
    }
  }
});

test("openai-compat-http accepts apiKeyFile alone as a key source", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-registry-342-"));
  const file = join(dir, "key");
  try {
    writeFileSync(file, "file-key");
    const adapter = buildAdapter("openai-compat-http", {
      baseUrl: "http://x/v1",
      model: "m",
      apiKeyFile: file,
    });
    expect(adapter.kind).toBe("openai-compat-http");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["claude-cli", "gemini-cli", "agy-cli", "codex-cli"])("%s requires command", (kind) => {
  expect(() => buildAdapter(kind, {})).toThrow(`${kind}: command is required`);
});

test("opencode-cli requires model", () => {
  expect(() => buildAdapter("opencode-cli", {})).toThrow(/opencode-cli: model is required/);
});

test("opencode-acp requires model", () => {
  expect(() => buildAdapter("opencode-acp", {})).toThrow(/opencode-acp: model is required/);
});

test("a custom kind registered via registerAdapter is buildable", () => {
  const stub: Adapter = { kind: "custom-x", dispatch: () => Promise.resolve({ text: "" }) };
  registerAdapter("custom-x", () => stub);
  expect(buildAdapter("custom-x", {}).kind).toBe("custom-x");
});

test("clearCustomAdapters removes custom kinds", () => {
  const stub: Adapter = { kind: "custom-y", dispatch: () => Promise.resolve({ text: "" }) };
  registerAdapter("custom-y", () => stub);
  clearCustomAdapters();
  expect(() => buildAdapter("custom-y", {})).toThrow(/unknown adapter kind: custom-y/);
});

test("clearCustomAdapters keeps built-in kinds", () => {
  clearCustomAdapters();
  expect(buildAdapter("claude-cli", { command: "cat" }).kind).toBe("claude-cli");
});
