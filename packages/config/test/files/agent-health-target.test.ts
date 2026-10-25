import { describe, expect, test } from "bun:test";

import { AgentConfigSchema } from "@src/files/agents.js";

const baseAgent = { name: "a", adapter: "stdio-acp" };

describe("AgentConfigSchema health target", () => {
  test("accepts a minimal health block with only a url", () => {
    const parsed = AgentConfigSchema.parse({
      ...baseAgent,
      health: { url: "https://gw.example.invalid:7843/v1" },
    });
    expect(parsed.health).toEqual({ url: "https://gw.example.invalid:7843/v1" });
  });

  test("accepts all four fields with absolute and ~/ paths", () => {
    const health = {
      url: "https://gw.example.invalid:7843/v1",
      bearer_file: "/etc/penumbra/token",
      ca_file: "~/certs/gw-ca.pem",
      expect_model: "qwen",
    };
    const parsed = AgentConfigSchema.parse({ ...baseAgent, health });
    expect(parsed.health).toEqual(health);
  });

  test("rejects an unknown key inside health", () => {
    expect(() =>
      AgentConfigSchema.parse({
        ...baseAgent,
        health: { url: "https://gw.example.invalid:7843/v1", token: "inline" },
      }),
    ).toThrow();
  });

  test("rejects a relative bearer_file", () => {
    expect(() =>
      AgentConfigSchema.parse({
        ...baseAgent,
        health: { url: "https://gw.example.invalid:7843/v1", bearer_file: "token.txt" },
      }),
    ).toThrow(/absolute path|~\//);
  });

  test("rejects a non-http url", () => {
    expect(() => AgentConfigSchema.parse({ ...baseAgent, health: { url: "ftp://x" } })).toThrow(
      /http\(s\) URL/,
    );
  });

  test("rejects a url that does not parse", () => {
    expect(() => AgentConfigSchema.parse({ ...baseAgent, health: { url: "not a url" } })).toThrow(
      /http\(s\) URL/,
    );
  });

  test("rejects an empty expect_model", () => {
    expect(() =>
      AgentConfigSchema.parse({ ...baseAgent, health: { url: "http://x", expect_model: "" } }),
    ).toThrow();
  });

  test("a seat without health parses with health undefined", () => {
    const parsed = AgentConfigSchema.parse(baseAgent);
    expect(parsed.health).toBeUndefined();
  });
});
