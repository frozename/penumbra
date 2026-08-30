import { resolveAdapterApiKey } from "@src/adapters/secret.js";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("resolveAdapterApiKey: literal apiKey wins (back-compat)", () => {
  expect(resolveAdapterApiKey({ apiKey: "literal-123" })).toBe("literal-123");
});

test("resolveAdapterApiKey: apiKeyEnv reads process.env", () => {
  process.env.AGENTCHAT_TEST_K = "from-env";
  try {
    expect(resolveAdapterApiKey({ apiKeyEnv: "AGENTCHAT_TEST_K" })).toBe("from-env");
  } finally {
    delete process.env.AGENTCHAT_TEST_K;
  }
});

test("resolveAdapterApiKey: missing env var throws with the var name", () => {
  delete process.env.AGENTCHAT_DEFINITELY_UNSET;
  expect(() => resolveAdapterApiKey({ apiKeyEnv: "AGENTCHAT_DEFINITELY_UNSET" })).toThrow(
    /AGENTCHAT_DEFINITELY_UNSET/,
  );
});

test("resolveAdapterApiKey: apiKeyFile reads file content trimmed", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-"));
  try {
    writeFileSync(join(dir, "k.txt"), "from-file\n");
    expect(resolveAdapterApiKey({ apiKeyFile: join(dir, "k.txt") })).toBe("from-file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAdapterApiKey: apiKeyKeychain shells out to security on darwin (mocked)", () => {
  const calls: string[][] = [];
  const fakeRun = (service: string, account: string): string => {
    calls.push([service, account]);
    return "from-keychain\n";
  };
  expect(
    resolveAdapterApiKey(
      { apiKeyKeychain: "llamactl/nvidia" },
      { hostPlatform: "darwin", runSecurityCli: fakeRun },
    ),
  ).toBe("from-keychain");
  expect(calls).toEqual([["llamactl", "nvidia"]]);
});

test("resolveAdapterApiKey: apiKeyKeychain rejects malformed ref (no slash)", () => {
  expect(() =>
    resolveAdapterApiKey(
      { apiKeyKeychain: "no-slash-here" },
      { hostPlatform: "darwin", runSecurityCli: () => "" },
    ),
  ).toThrow(/<service>\/<account>/);
});

test("resolveAdapterApiKey: apiKeyKeychain throws on non-darwin", () => {
  expect(() =>
    resolveAdapterApiKey(
      { apiKeyKeychain: "llamactl/nvidia" },
      { hostPlatform: "linux", runSecurityCli: () => "" },
    ),
  ).toThrow(/macOS/);
});

test("resolveAdapterApiKey: precedence is apiKey > apiKeyEnv > apiKeyKeychain > apiKeyFile", () => {
  process.env.AGENTCHAT_PREC = "env-value";
  const dir = mkdtempSync(join(tmpdir(), "prec-"));
  try {
    writeFileSync(join(dir, "k.txt"), "file-value");
    // All four set; apiKey wins.
    expect(
      resolveAdapterApiKey(
        {
          apiKey: "literal",
          apiKeyEnv: "AGENTCHAT_PREC",
          apiKeyKeychain: "llamactl/nvidia",
          apiKeyFile: join(dir, "k.txt"),
        },
        { hostPlatform: "darwin", runSecurityCli: () => "kc" },
      ),
    ).toBe("literal");
    // No literal; env wins over keychain + file.
    expect(
      resolveAdapterApiKey(
        {
          apiKeyEnv: "AGENTCHAT_PREC",
          apiKeyKeychain: "llamactl/nvidia",
          apiKeyFile: join(dir, "k.txt"),
        },
        { hostPlatform: "darwin", runSecurityCli: () => "kc" },
      ),
    ).toBe("env-value");
    // No literal/env; keychain wins over file.
    expect(
      resolveAdapterApiKey(
        {
          apiKeyKeychain: "llamactl/nvidia",
          apiKeyFile: join(dir, "k.txt"),
        },
        { hostPlatform: "darwin", runSecurityCli: () => "kc" },
      ),
    ).toBe("kc");
    // Only file.
    expect(resolveAdapterApiKey({ apiKeyFile: join(dir, "k.txt") })).toBe("file-value");
  } finally {
    delete process.env.AGENTCHAT_PREC;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAdapterApiKey: nothing provided returns empty string (anonymous, back-compat)", () => {
  expect(resolveAdapterApiKey({})).toBe("");
});
