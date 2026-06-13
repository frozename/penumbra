import { describe, expect, test } from "bun:test";
import {
  AgentChatConfigSchema,
  AgentOptionsSchema,
  PlanSynthesizerSchema,
  PlannerPersonaSchema,
  ReviewPersonaSchema,
  ReviewSynthesizerSchema,
} from "../../src/config/types.js";

describe("AgentOptionsSchema — Phase 1d boolean opt-ins", () => {
  test("fsReadTextFile defaults to undefined", () => {
    const result = AgentOptionsSchema.parse({});
    expect(result.fsReadTextFile).toBeUndefined();
  });

  test("fsReadTextFile parses true", () => {
    const result = AgentOptionsSchema.parse({ fsReadTextFile: true });
    expect(result.fsReadTextFile).toBe(true);
  });

  test("fsReadTextFile rejects non-boolean", () => {
    expect(() => AgentOptionsSchema.parse({ fsReadTextFile: "yes" })).toThrow();
  });

  test("fsWriteTextFile defaults to undefined", () => {
    const result = AgentOptionsSchema.parse({});
    expect(result.fsWriteTextFile).toBeUndefined();
  });

  test("fsWriteTextFile parses true", () => {
    const result = AgentOptionsSchema.parse({ fsWriteTextFile: true });
    expect(result.fsWriteTextFile).toBe(true);
  });

  test("fsWriteTextFile rejects non-boolean", () => {
    expect(() => AgentOptionsSchema.parse({ fsWriteTextFile: 1 })).toThrow();
  });

  test("terminal defaults to undefined", () => {
    const result = AgentOptionsSchema.parse({});
    expect(result.terminal).toBeUndefined();
  });

  test("terminal parses true", () => {
    const result = AgentOptionsSchema.parse({ terminal: true });
    expect(result.terminal).toBe(true);
  });

  test("terminal rejects non-boolean", () => {
    expect(() => AgentOptionsSchema.parse({ terminal: "yes" })).toThrow();
  });

  test("mcpWriteTools defaults to undefined", () => {
    const result = AgentOptionsSchema.parse({});
    expect(result.mcpWriteTools).toBeUndefined();
  });

  test("mcpWriteTools parses true", () => {
    const result = AgentOptionsSchema.parse({ mcpWriteTools: true });
    expect(result.mcpWriteTools).toBe(true);
  });

  test("mcpWriteTools rejects non-boolean", () => {
    expect(() => AgentOptionsSchema.parse({ mcpWriteTools: 0 })).toThrow();
  });

  test("requestTimeoutMs parses a positive millisecond timeout", () => {
    const result = AgentOptionsSchema.parse({ requestTimeoutMs: 300_000 });
    expect(result.requestTimeoutMs).toBe(300_000);
  });

  test("requestTimeoutMs rejects sub-second values", () => {
    expect(() => AgentOptionsSchema.parse({ requestTimeoutMs: 999 })).toThrow();
  });
});

describe("AgentOptionsSchema — Phase 1d sandbox knobs", () => {
  test("terminal_path parses a string", () => {
    const result = AgentOptionsSchema.parse({ terminal_path: "/usr/bin:/bin" });
    expect(result.terminal_path).toBe("/usr/bin:/bin");
  });

  test("terminal_timeout_s — 30 parses", () => {
    const result = AgentOptionsSchema.parse({ terminal_timeout_s: 30 });
    expect(result.terminal_timeout_s).toBe(30);
  });

  test("terminal_timeout_s — 0 throws", () => {
    expect(() => AgentOptionsSchema.parse({ terminal_timeout_s: 0 })).toThrow();
  });

  test("terminal_timeout_s — 301 throws", () => {
    expect(() => AgentOptionsSchema.parse({ terminal_timeout_s: 301 })).toThrow();
  });

  test("terminal_output_max_bytes — 1048576 parses", () => {
    const result = AgentOptionsSchema.parse({ terminal_output_max_bytes: 1048576 });
    expect(result.terminal_output_max_bytes).toBe(1048576);
  });

  test("terminal_output_max_bytes — 8388609 throws", () => {
    expect(() => AgentOptionsSchema.parse({ terminal_output_max_bytes: 8388609 })).toThrow();
  });

  test("terminal_output_max_bytes — 1023 throws", () => {
    expect(() => AgentOptionsSchema.parse({ terminal_output_max_bytes: 1023 })).toThrow();
  });

  test("terminal_max_concurrent — 3 parses", () => {
    const result = AgentOptionsSchema.parse({ terminal_max_concurrent: 3 });
    expect(result.terminal_max_concurrent).toBe(3);
  });

  test("terminal_max_concurrent — 9 throws", () => {
    expect(() => AgentOptionsSchema.parse({ terminal_max_concurrent: 9 })).toThrow();
  });

  test("terminal_max_concurrent — 0 throws", () => {
    expect(() => AgentOptionsSchema.parse({ terminal_max_concurrent: 0 })).toThrow();
  });
});

describe("AgentChatConfigSchema — adversarial review config blocks", () => {
  const baseConfig = {
    agents: [
      { name: "claude", adapter: "claude-cli" },
      { name: "gemini", adapter: "gemini-cli" },
    ],
  };

  test("config without review_personas parses", () => {
    const parsed = AgentChatConfigSchema.parse(baseConfig);
    expect(parsed.review_personas).toBeUndefined();
  });

  test("config with valid review_personas parses", () => {
    const parsed = AgentChatConfigSchema.parse({
      ...baseConfig,
      review_personas: {
        architect: {
          name: "architect",
          bias: "long-term architecture and modularity",
          system_prompt: "Review with architecture lens.",
          preferred_agent: "claude",
          category_hints: ["design", "maintainability"],
          optional: true,
          description: "Checks structural integrity.",
        },
        security: {
          name: "security",
          bias: "threat modeling and hardening",
          system_prompt: "Review with security lens.",
          preferred_agent: "gemini",
        },
      },
    });

    expect(parsed.review_personas?.architect?.preferred_agent).toBe("claude");
    expect(parsed.review_personas?.architect?.optional).toBe(true);
    expect(parsed.review_personas?.security?.category_hints).toBeUndefined();
  });

  test("review_personas reject legacy blocking marker", () => {
    expect(() =>
      AgentChatConfigSchema.parse({
        ...baseConfig,
        review_personas: {
          architect: {
            name: "architect",
            bias: "long-term architecture and modularity",
            system_prompt: "Review with architecture lens.",
            preferred_agent: "claude",
            blocking: false,
          },
        },
      }),
    ).toThrow(/blocking/);
  });

  test("review_personas rejects missing required fields", () => {
    expect(() =>
      AgentChatConfigSchema.parse({
        ...baseConfig,
        review_personas: {
          architect: {
            name: "architect",
            bias: "long-term architecture and modularity",
            system_prompt: "Review with architecture lens.",
          },
        },
      }),
    ).toThrow();
  });

  test("review_synthesizer parses valid shape and rejects missing fields", () => {
    const parsed = AgentChatConfigSchema.parse({
      ...baseConfig,
      review_synthesizer: {
        preferred_agent: "claude",
        system_prompt: "Synthesize persona findings into one decision.",
      },
    });
    expect(parsed.review_synthesizer?.preferred_agent).toBe("claude");

    expect(() =>
      AgentChatConfigSchema.parse({
        ...baseConfig,
        review_synthesizer: {
          preferred_agent: "claude",
        },
      }),
    ).toThrow();
  });

  test("review and plan synthesizers accept preferred_agent pools without coercion", () => {
    const reviewPool = ReviewSynthesizerSchema.parse({
      preferred_agent: ["claude", "gemini"],
      system_prompt: "Synthesize persona findings.",
    });
    expect(reviewPool.preferred_agent).toEqual(["claude", "gemini"]);

    const reviewSingle = ReviewSynthesizerSchema.parse({
      preferred_agent: "claude",
      system_prompt: "Synthesize persona findings.",
    });
    expect(reviewSingle.preferred_agent).toBe("claude");

    const planPool = PlanSynthesizerSchema.parse({
      preferred_agent: ["claude", "gemini"],
      system_prompt: "Synthesize plan findings.",
    });
    expect(planPool.preferred_agent).toEqual(["claude", "gemini"]);

    const planSingle = PlanSynthesizerSchema.parse({
      preferred_agent: "gemini",
      system_prompt: "Synthesize plan findings.",
    });
    expect(planSingle.preferred_agent).toBe("gemini");
  });

  test("review and planner personas accept preferred_agent pools and reject empty strings", () => {
    const reviewPool = ReviewPersonaSchema.parse({
      name: "architect",
      bias: "architecture",
      system_prompt: "Review with architecture lens.",
      preferred_agent: ["claude", "gemini"],
    });
    expect(reviewPool.preferred_agent).toEqual(["claude", "gemini"]);

    const plannerPool = PlannerPersonaSchema.parse({
      name: "risk",
      bias: "risk",
      system_prompt: "Review with risk lens.",
      preferred_agent: ["claude", "gemini"],
    });
    expect(plannerPool.preferred_agent).toEqual(["claude", "gemini"]);

    expect(() =>
      ReviewPersonaSchema.parse({
        name: "architect",
        bias: "architecture",
        system_prompt: "Review with architecture lens.",
        preferred_agent: "",
      }),
    ).toThrow();
    expect(() =>
      PlannerPersonaSchema.parse({
        name: "risk",
        bias: "risk",
        system_prompt: "Review with risk lens.",
        preferred_agent: "",
      }),
    ).toThrow();
  });
});
