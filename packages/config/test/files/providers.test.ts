import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProviderSourcesFromDir, type ProviderSourcesConfig } from "../../src/index.js";
import { removeRecursive, writeUtf8 } from "../_fs-helpers.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), "provider-sources-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeRecursive(dir);
  }
});

describe("providers.yaml", () => {
  test("loadProviderSourcesFromDir parses a provider with nested cli/stdio-acp/openai-compat-http bindings, each stamping its own pricing_mode/api_provider", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "providers.yaml"),
      `
anthropic:
  discovery:
    kind: command
    locator: claude models
  auth:
    keychain: penumbra-anthropic
    oauth_marker: ~/.claude/.credentials.json
  bindings:
    claude-cli:
      kind: cli
      pricing_mode: subscription
      api_provider: anthropic
      subscription_provider: anthropic
      model_carrier: model
      seat_name_template: claude-{model}
    claude-acp:
      kind: stdio-acp
      pricing_mode: subscription
      api_provider: anthropic
      subscription_provider: anthropic
      model_carrier: model
      seat_name_template: claude-acp-{model}
    anthropic-http:
      kind: openai-compat-http
      pricing_mode: api
      api_provider: anthropic
      model_carrier: model
      seat_name_template: anthropic-{model}-http
`,
    );

    expect(loadProviderSourcesFromDir(dir)).toEqual({
      anthropic: {
        discovery: {
          kind: "command",
          locator: "claude models",
        },
        auth: {
          keychain: "penumbra-anthropic",
          oauth_marker: "~/.claude/.credentials.json",
        },
        bindings: {
          "claude-cli": {
            kind: "cli",
            pricing_mode: "subscription",
            api_provider: "anthropic",
            subscription_provider: "anthropic",
            model_carrier: "model",
            seat_name_template: "claude-{model}",
          },
          "claude-acp": {
            kind: "stdio-acp",
            pricing_mode: "subscription",
            api_provider: "anthropic",
            subscription_provider: "anthropic",
            model_carrier: "model",
            seat_name_template: "claude-acp-{model}",
          },
          "anthropic-http": {
            kind: "openai-compat-http",
            pricing_mode: "api",
            api_provider: "anthropic",
            model_carrier: "model",
            seat_name_template: "anthropic-{model}-http",
          },
        },
      },
    } satisfies ProviderSourcesConfig);
  });

  test("an openai-compat-http binding must declare pricing_mode and api_provider explicitly — no default", () => {
    const dir = makeTempDir();
    const binding = `
openai:
  discovery:
    kind: endpoint
    locator: https://api.openai.com/v1/models
  auth: {}
  bindings:
    openai-http:
      kind: openai-compat-http
      model_carrier: id
      seat_name_template: openai-{model}-http
`;

    writeUtf8(join(dir, "providers.yaml"), `${binding}      api_provider: openai\n`);
    expect(() => loadProviderSourcesFromDir(dir)).toThrow(/pricing_mode/);

    writeUtf8(join(dir, "providers.yaml"), `${binding}      pricing_mode: api\n`);
    expect(() => loadProviderSourcesFromDir(dir)).toThrow(/api_provider/);
  });

  test("defaults to an empty config when providers.yaml is absent, mirroring model-aliases.yaml's empty-file semantics", () => {
    const loaded = loadProviderSourcesFromDir(makeTempDir());

    expect(loaded).toEqual({});
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  test("the parsed config's top-level shape has no field named providers — regression pin against the quotas.yaml providers-array collision (§0.1)", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "providers.yaml"),
      `
openai:
  discovery:
    kind: endpoint
    locator: https://api.openai.com/v1/models
  auth: {}
  bindings:
    openai-http:
      kind: openai-compat-http
      pricing_mode: api
      api_provider: openai
      model_carrier: id
      seat_name_template: openai-{model}-http
`,
    );

    const loaded = loadProviderSourcesFromDir(dir);

    expect(loaded).toHaveProperty("openai");
    expect(loaded).not.toHaveProperty("providers");
  });
});
