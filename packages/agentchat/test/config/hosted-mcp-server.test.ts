import { describe, expect, test } from "bun:test";

import { HostedMcpServerSchema } from "../../src/config/types.js";

describe("HostedMcpServerSchema", () => {
  test("requires name and command, with default args and env", () => {
    const result = HostedMcpServerSchema.parse({
      name: "server-one",
      command: "node",
    });

    expect(result.args).toEqual([]);
    expect(result.env).toEqual([]);
  });

  test("rejects empty name", () => {
    expect(() =>
      HostedMcpServerSchema.parse({
        name: "",
        command: "node",
      }),
    ).toThrow();
  });

  test("rejects empty command", () => {
    expect(() =>
      HostedMcpServerSchema.parse({
        name: "server-one",
        command: "",
      }),
    ).toThrow();
  });

  test("allows empty env value strings", () => {
    const result = HostedMcpServerSchema.parse({
      name: "server-one",
      command: "node",
      env: [{ name: "CONFIG_VAL", value: "" }],
    });

    expect(result.env).toEqual([{ name: "CONFIG_VAL", value: "" }]);
  });

  test("rejects whitespace-only command", () => {
    expect(() =>
      HostedMcpServerSchema.parse({
        name: "server-one",
        command: "   ",
      }),
    ).toThrow();
  });

  test("rejects whitespace-only name", () => {
    expect(() =>
      HostedMcpServerSchema.parse({
        name: "  ",
        command: "node",
      }),
    ).toThrow();
  });

  test("rejects empty env name", () => {
    expect(() =>
      HostedMcpServerSchema.parse({
        name: "server-one",
        command: "node",
        env: [{ name: "", value: "x" }],
      }),
    ).toThrow();
  });

  test("rejects whitespace-only env name", () => {
    expect(() =>
      HostedMcpServerSchema.parse({
        name: "server-one",
        command: "node",
        env: [{ name: "   ", value: "x" }],
      }),
    ).toThrow();
  });

  test("rejects duplicate env names", () => {
    expect(() =>
      HostedMcpServerSchema.parse({
        name: "server-one",
        command: "node",
        env: [
          { name: "X", value: "1" },
          { name: "X", value: "2" },
        ],
      }),
    ).toThrow();
  });

  test("rejects non-string args entries", () => {
    expect(() =>
      HostedMcpServerSchema.parse({
        name: "server-one",
        command: "node",
        args: ["--flag", 1],
      }),
    ).toThrow();
  });
});
