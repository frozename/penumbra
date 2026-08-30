import { describe, expect, test } from "bun:test";

import { applyBindingCarriers, renderTemplateTokens } from "../../src/generator/carriers.js";

describe("renderTemplateTokens", () => {
  test("replaces {model}, {tier}, {displayName} in every token", () => {
    expect(
      renderTemplateTokens(["--model={model}", "--tier={tier}", "--name={displayName}"], {
        modelId: "gpt-5.5",
        reasoningTier: "high",
        displayName: "GPT 5.5",
      }),
    ).toEqual(["--model=gpt-5.5", "--tier=high", "--name=GPT 5.5"]);
  });

  test("throws when a token references {tier} but reasoningTier is undefined", () => {
    expect(() =>
      renderTemplateTokens(["-c", "model_reasoning_effort={tier}"], {
        modelId: "gpt-5.5",
      }),
    ).toThrow(/reasoningTier/);
  });

  test("keeps carrier template tier placeholders strict when reasoningTier is undefined", () => {
    expect(() =>
      applyBindingCarriers(
        {},
        {
          binary: "codex",
          args_template: ["-c", "model_reasoning_effort={tier}"],
        },
        "stdio-acp",
        {
          modelId: "gpt-5.5",
        },
      ),
    ).toThrow(/reasoningTier/);
  });

  test("throws when a token leaves an unknown placeholder-shaped segment", () => {
    expect(() =>
      renderTemplateTokens(["--model={modle}"], {
        modelId: "gpt-5.5",
      }),
    ).toThrow(/--model=\{modle\}.*\{modle\}/);
  });

  test("substitution is value-level: a model id containing ' -c model_provider=evil ' yields exactly the templated element count", () => {
    const rendered = renderTemplateTokens(["--model", "{model}", "--display", "{displayName}"], {
      modelId: "gpt-5.5 -c model_provider=evil ",
      displayName: "GPT 5.5",
    });

    expect(rendered).toEqual([
      "--model",
      "gpt-5.5 -c model_provider=evil ",
      "--display",
      "GPT 5.5",
    ]);
    expect(rendered).toHaveLength(4);
  });
});

describe("applyBindingCarriers", () => {
  test("routes carriers.binary to options.binary (stdio-acp), options.opencodeBinary (opencode-acp), options.command (agy-cli/cli)", () => {
    expect(
      applyBindingCarriers({}, { binary: "codex-acp" }, "stdio-acp", {
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      options: { binary: "codex-acp" },
      topLevel: {},
      managedFields: ["options.binary"],
    });
    expect(
      applyBindingCarriers({}, { binary: "opencode" }, "opencode-acp", {
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      options: { opencodeBinary: "opencode" },
      topLevel: {},
      managedFields: ["options.opencodeBinary"],
    });
    expect(
      applyBindingCarriers({}, { binary: "agy" }, "agy-cli", {
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      options: { command: "agy" },
      topLevel: {},
      managedFields: ["options.command"],
    });
    expect(
      applyBindingCarriers({}, { binary: "codex" }, "cli", {
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      options: { command: "codex" },
      topLevel: {},
      managedFields: ["options.command"],
    });
  });

  test("threads the seven terminal/fs tool options as literal option values in fixed managed-field order", () => {
    expect(
      applyBindingCarriers(
        {},
        {
          binary: "codex-acp",
          fsReadTextFile: true,
          fsWriteTextFile: true,
          terminal: true,
          terminal_max_concurrent: 3,
          terminal_output_max_bytes: 65536,
          terminal_path: "/usr/bin:/bin",
          terminal_timeout_s: 120,
        },
        "stdio-acp",
        { modelId: "m" },
      ),
    ).toEqual({
      options: {
        binary: "codex-acp",
        fsReadTextFile: true,
        fsWriteTextFile: true,
        terminal: true,
        terminal_max_concurrent: 3,
        terminal_output_max_bytes: 65536,
        terminal_path: "/usr/bin:/bin",
        terminal_timeout_s: 120,
      },
      topLevel: {},
      managedFields: [
        "options.binary",
        "options.fsReadTextFile",
        "options.fsWriteTextFile",
        "options.terminal",
        "options.terminal_max_concurrent",
        "options.terminal_output_max_bytes",
        "options.terminal_path",
        "options.terminal_timeout_s",
      ],
    });
  });

  test("tool-option carrier values are copied literally — template tokens are NOT rendered", () => {
    const result = applyBindingCarriers({}, { terminal_path: "/opt/{model}/bin" }, "stdio-acp", {
      modelId: "gpt-5.5",
    });

    expect(result.options.terminal_path).toBe("/opt/{model}/bin");
    expect(result.managedFields).toEqual(["options.terminal_path"]);
  });

  test("a binary-only carriers block produces no tool-option keys in options or managedFields", () => {
    const result = applyBindingCarriers({}, { binary: "codex-acp" }, "stdio-acp", {
      modelId: "gpt-5.5",
    });

    for (const key of [
      "fsReadTextFile",
      "fsWriteTextFile",
      "terminal",
      "terminal_max_concurrent",
      "terminal_output_max_bytes",
      "terminal_path",
      "terminal_timeout_s",
    ]) {
      expect(result.options).not.toHaveProperty(key);
    }
    expect(result.managedFields).toEqual(["options.binary"]);
  });

  test("threads tool options identically for opencode-acp and agy-cli kinds", () => {
    expect(
      applyBindingCarriers(
        {},
        { binary: "opencode", terminal: true, terminal_timeout_s: 300 },
        "opencode-acp",
        { modelId: "m" },
      ),
    ).toEqual({
      options: { opencodeBinary: "opencode", terminal: true, terminal_timeout_s: 300 },
      topLevel: {},
      managedFields: ["options.opencodeBinary", "options.terminal", "options.terminal_timeout_s"],
    });

    expect(
      applyBindingCarriers(
        {},
        { binary: "agy", fsWriteTextFile: true, terminal_max_concurrent: 8 },
        "agy-cli",
        { modelId: "m" },
      ),
    ).toEqual({
      options: { command: "agy", fsWriteTextFile: true, terminal_max_concurrent: 8 },
      topLevel: {},
      managedFields: [
        "options.command",
        "options.fsWriteTextFile",
        "options.terminal_max_concurrent",
      ],
    });
  });

  test("threads pass_via and strip_patterns for agy-cli", () => {
    expect(
      applyBindingCarriers(
        {},
        { pass_via: "argv", strip_patterns: ["secret", "token"] },
        "agy-cli",
        { modelId: "m" },
      ),
    ).toEqual({
      options: { pass_via: "argv", strip_patterns: ["secret", "token"] },
      topLevel: {},
      managedFields: ["options.pass_via", "options.strip_patterns"],
    });
  });

  test("sets options.args/env/unsetEnv/mcpServers/authMethodId and returns exactly their dot-paths as managedFields", () => {
    const result = applyBindingCarriers(
      { cwd: "/repo" },
      {
        args_template: ["--model", "{model}", "--tier", "{tier}"],
        env: {
          MODEL_ID: "{model}",
          MODEL_NAME: "{displayName}",
        },
        unset_env: ["OPENAI_API_KEY"],
        mcp_servers: {
          penumbra: {
            command: "bun",
            args: ["packages/mcp/bin/penumbra-mcp.ts"],
          },
        },
        authMethodId: "openai-subscription",
      },
      "stdio-acp",
      {
        modelId: "gpt-5.5",
        reasoningTier: "high",
        displayName: "GPT 5.5",
      },
    );

    expect(result).toEqual({
      options: {
        cwd: "/repo",
        args: ["--model", "gpt-5.5", "--tier", "high"],
        env: {
          MODEL_ID: "gpt-5.5",
          MODEL_NAME: "GPT 5.5",
        },
        unsetEnv: ["OPENAI_API_KEY"],
        mcpServers: {
          penumbra: {
            command: "bun",
            args: ["packages/mcp/bin/penumbra-mcp.ts"],
          },
        },
        authMethodId: "openai-subscription",
      },
      topLevel: {},
      managedFields: [
        "options.args",
        "options.env",
        "options.unsetEnv",
        "options.mcpServers",
        "options.authMethodId",
      ],
    });
  });

  test("with no carriers block returns base options untouched and an empty managedFields list", () => {
    const baseOptions = { cwd: "/repo", env: { KEEP: "yes" } };

    expect(
      applyBindingCarriers(baseOptions, undefined, "stdio-acp", {
        modelId: "gpt-5.5",
      }),
    ).toEqual({
      options: baseOptions,
      topLevel: {},
      managedFields: [],
    });
  });

  test("subscription_model_source stamps top-level subscription_model (sibling of options), reported separately from option paths", () => {
    expect(
      applyBindingCarriers({}, { subscription_model_source: "displayName" }, "stdio-acp", {
        modelId: "claude-opus-4-1",
        displayName: "Claude Opus 4.1",
      }),
    ).toEqual({
      options: {},
      topLevel: { subscription_model: "Claude Opus 4.1" },
      managedFields: ["subscription_model"],
    });
  });
});
