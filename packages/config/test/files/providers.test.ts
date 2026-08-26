import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadProviderSourcesFromDir,
  resolveCatalogAuthority,
  type ProviderSourcesConfig,
} from "../../src/index.js";
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
  test("a stdio-acp binding round-trips carriers.{binary,args_template,env,unset_env,mcp_servers,authMethodId,subscription_model_source}", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "providers.yaml"),
      `
anthropic:
  discovery:
    kind: acp-session
    locator: claude-acp
  auth: {}
  bindings:
    claude-acp:
      kind: stdio-acp
      pricing_mode: subscription
      api_provider: anthropic
      subscription_provider: anthropic
      model_carrier: model
      seat_name_template: claude-acp-{model}
      carriers:
        binary: claude-agent-acp
        args_template: [--model, "{model}", --tier, "{tier}"]
        env:
          PENUMBRA_DISPLAY_NAME: "{displayName}"
          PENUMBRA_MODEL: "{model}"
        unset_env: [ANTHROPIC_API_KEY]
        mcp_servers:
          penumbra:
            command: bun
            args: [packages/mcp/bin/penumbra-mcp.ts]
        authMethodId: claude-subscription
        subscription_model_source: displayName
`,
    );

    expect(loadProviderSourcesFromDir(dir).anthropic?.bindings["claude-acp"]?.carriers).toEqual({
      binary: "claude-agent-acp",
      args_template: ["--model", "{model}", "--tier", "{tier}"],
      env: {
        PENUMBRA_DISPLAY_NAME: "{displayName}",
        PENUMBRA_MODEL: "{model}",
      },
      unset_env: ["ANTHROPIC_API_KEY"],
      mcp_servers: {
        penumbra: {
          command: "bun",
          args: ["packages/mcp/bin/penumbra-mcp.ts"],
        },
      },
      authMethodId: "claude-subscription",
      subscription_model_source: "displayName",
    });
  });

  test("carriers is optional — an existing openai-compat-http binding with no carriers block still parses", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "providers.yaml"),
      `
openai:
  discovery:
    kind: http
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

    expect(loadProviderSourcesFromDir(dir).openai?.bindings["openai-http"]).toEqual({
      kind: "openai-compat-http",
      pricing_mode: "api",
      api_provider: "openai",
      model_carrier: "id",
      seat_name_template: "openai-{model}-http",
    });
  });

  test("carriers rejects an unknown key", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "providers.yaml"),
      `
anthropic:
  discovery:
    kind: acp-session
    locator: claude-acp
  auth: {}
  bindings:
    claude-acp:
      kind: stdio-acp
      pricing_mode: subscription
      api_provider: anthropic
      subscription_provider: anthropic
      model_carrier: model
      seat_name_template: claude-acp-{model}
      carriers:
        args_tempalte: [--model, "{model}"]
`,
    );

    expect(() => loadProviderSourcesFromDir(dir)).toThrow(/args_tempalte/);
  });

  test("carriers.args_template rejects an empty array; carriers.binary rejects an empty string", () => {
    const dir = makeTempDir();
    const fixture = `
anthropic:
  discovery:
    kind: acp-session
    locator: claude-acp
  auth: {}
  bindings:
    claude-acp:
      kind: stdio-acp
      pricing_mode: subscription
      api_provider: anthropic
      subscription_provider: anthropic
      model_carrier: model
      seat_name_template: claude-acp-{model}
      carriers:
        args_template: []
`;

    writeUtf8(join(dir, "providers.yaml"), fixture);
    expect(() => loadProviderSourcesFromDir(dir)).toThrow(/args_template/);

    writeUtf8(join(dir, "providers.yaml"), fixture.replace("args_template: []", 'binary: ""'));
    expect(() => loadProviderSourcesFromDir(dir)).toThrow(/binary/);
  });

  test("resolveCatalogAuthority derives 'session-handshake' for discovery.kind 'acp-session' and 'provider-catalog' otherwise when unset", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "providers.yaml"),
      `
anthropic:
  discovery:
    kind: acp-session
    locator: claude-acp
  auth: {}
  bindings:
    claude-acp:
      kind: stdio-acp
      pricing_mode: subscription
      api_provider: anthropic
      subscription_provider: anthropic
      model_carrier: model
      seat_name_template: claude-acp-{model}
openai:
  discovery:
    kind: http
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
    const anthropic = loaded.anthropic;
    const openai = loaded.openai;

    expect(resolveCatalogAuthority(anthropic!.bindings["claude-acp"]!, anthropic!)).toBe(
      "session-handshake",
    );
    expect(resolveCatalogAuthority(openai!.bindings["openai-http"]!, openai!)).toBe(
      "provider-catalog",
    );
  });

  test("resolveCatalogAuthority preserves an explicit 'provider-catalog' override for discovery.kind 'acp-session'", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "providers.yaml"),
      `
anthropic:
  discovery:
    kind: acp-session
    locator: claude-acp
  auth: {}
  bindings:
    claude-acp:
      kind: stdio-acp
      pricing_mode: subscription
      api_provider: anthropic
      subscription_provider: anthropic
      model_carrier: model
      seat_name_template: claude-acp-{model}
      catalog_authority: provider-catalog
`,
    );
    const source = loadProviderSourcesFromDir(dir).anthropic!;
    const binding = source.bindings["claude-acp"]!;

    expect(binding.catalog_authority).toBe("provider-catalog");
    expect(resolveCatalogAuthority(binding, source)).toBe("provider-catalog");
  });

  test("loadProviderSourcesFromDir throws when a binding declares catalog_authority:'session-handshake' under a source whose discovery.kind is 'http'", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "providers.yaml"),
      `
openai:
  discovery:
    kind: http
    locator: https://api.openai.com/v1/models
  auth: {}
  bindings:
    openai-http:
      kind: openai-compat-http
      pricing_mode: api
      api_provider: openai
      model_carrier: id
      seat_name_template: openai-{model}-http
      catalog_authority: session-handshake
`,
    );

    expect(() => loadProviderSourcesFromDir(dir)).toThrow(
      /bindings\.openai-http\.catalog_authority: catalog_authority.*session-handshake.*acp-session/,
    );
  });

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

  test("round-trips per-source model exclusions and rejects empty entries", () => {
    const dir = makeTempDir();
    const fixture = `
sakana:
  discovery:
    kind: endpoint
    locator: https://api.sakana.ai/v1/models
  auth: {}
  exclude_models: [fugu-ultra]
  bindings: {}
`;
    writeUtf8(join(dir, "providers.yaml"), fixture);

    expect(loadProviderSourcesFromDir(dir)).toEqual({
      sakana: {
        discovery: {
          kind: "endpoint",
          locator: "https://api.sakana.ai/v1/models",
        },
        auth: {},
        exclude_models: ["fugu-ultra"],
        bindings: {},
      },
    } satisfies ProviderSourcesConfig);

    writeUtf8(join(dir, "providers.yaml"), fixture.replace("fugu-ultra", "''"));

    expect(() => loadProviderSourcesFromDir(dir)).toThrow(/exclude_models/);
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
