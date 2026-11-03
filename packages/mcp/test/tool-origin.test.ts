import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { resolveToolOrigin } from "../src/tool-origin.js";

const ENV_KEY = "PENUMBRA_MCP_ORIGIN";

describe("resolveToolOrigin", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env["PENUMBRA_MCP_ORIGIN"];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env["PENUMBRA_MCP_ORIGIN"];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  it("returns undefined for non-object extra even when env is set", () => {
    process.env[ENV_KEY] = "env-origin";
    expect(resolveToolOrigin(undefined)).toBe(undefined);
    expect(resolveToolOrigin(null)).toBe(undefined);
    expect(resolveToolOrigin("x")).toBe(undefined);
    expect(resolveToolOrigin(42)).toBe(undefined);
    expect(resolveToolOrigin(false)).toBe(undefined);
  });

  it("falls back to the env origin when no metadata is present", () => {
    process.env[ENV_KEY] = "env-origin";
    expect(resolveToolOrigin({})).toBe("env-origin");
    delete process.env["PENUMBRA_MCP_ORIGIN"];
    expect(resolveToolOrigin({})).toBe(undefined);
    process.env[ENV_KEY] = "   ";
    expect(resolveToolOrigin({})).toBe(undefined);
  });

  it("prefers the header over _meta and env", () => {
    process.env[ENV_KEY] = "env-origin";
    const extra = {
      requestInfo: { headers: { "x-penumbra-origin": "hdr" } },
      _meta: { origin: "meta" },
    };
    expect(resolveToolOrigin(extra)).toBe("hdr");
  });

  it("accepts the capitalised header spelling and prefers lowercase when both are present", () => {
    expect(resolveToolOrigin({ requestInfo: { headers: { "X-Penumbra-Origin": "Cap" } } })).toBe(
      "Cap",
    );
    const both = {
      requestInfo: {
        headers: { "x-penumbra-origin": "lower", "X-Penumbra-Origin": "upper" },
      },
    };
    expect(resolveToolOrigin(both)).toBe("lower");
  });

  it("picks the first non-blank entry of an array header and falls through when all blank", () => {
    const extra = { requestInfo: { headers: { "x-penumbra-origin": ["", "   ", "second"] } } };
    expect(resolveToolOrigin(extra)).toBe("second");

    const allBlank = {
      requestInfo: { headers: { "x-penumbra-origin": ["", " "] } },
      _meta: { origin: "meta" },
    };
    expect(resolveToolOrigin(allBlank)).toBe("meta");
  });

  it("falls through a whitespace-only string header to _meta.origin", () => {
    const extra = {
      requestInfo: { headers: { "x-penumbra-origin": "   " } },
      _meta: { origin: "meta" },
    };
    expect(resolveToolOrigin(extra)).toBe("meta");
  });

  it("does not trim the returned value", () => {
    const extra = { requestInfo: { headers: { "x-penumbra-origin": "  padded  " } } };
    expect(resolveToolOrigin(extra)).toBe("  padded  ");
  });

  it("resolves _meta keys in origin, penumbra_origin, x-penumbra-origin order", () => {
    expect(
      resolveToolOrigin({ _meta: { origin: "o", penumbra_origin: "p", "x-penumbra-origin": "x" } }),
    ).toBe("o");
    expect(resolveToolOrigin({ _meta: { penumbra_origin: "p", "x-penumbra-origin": "x" } })).toBe(
      "p",
    );
    expect(resolveToolOrigin({ _meta: { "x-penumbra-origin": "x" } })).toBe("x");
    expect(resolveToolOrigin({ _meta: { origin: "  ", penumbra_origin: "p" } })).toBe("p");
  });

  it("picks the first non-blank entry of an array value in _meta", () => {
    expect(resolveToolOrigin({ _meta: { origin: [" ", "arr"] } })).toBe("arr");
  });

  it("ignores non-object _meta and missing or malformed requestInfo", () => {
    process.env[ENV_KEY] = "env-origin";
    expect(resolveToolOrigin({ _meta: "str" })).toBe("env-origin");
    expect(resolveToolOrigin({ _meta: null })).toBe("env-origin");
    expect(resolveToolOrigin({ _meta: { origin: "meta" } })).toBe("meta");
    expect(resolveToolOrigin({ requestInfo: {}, _meta: { origin: "meta" } })).toBe("meta");
    expect(resolveToolOrigin({ requestInfo: { headers: "str" }, _meta: { origin: "meta" } })).toBe(
      "meta",
    );
    expect(resolveToolOrigin({ requestInfo: { headers: {} } })).toBe("env-origin");
  });

  it("ignores non-string values in headers and _meta", () => {
    process.env[ENV_KEY] = "env-origin";
    expect(
      resolveToolOrigin({ requestInfo: { headers: { "x-penumbra-origin": undefined } } }),
    ).toBe("env-origin");
    expect(resolveToolOrigin({ _meta: { origin: 123, penumbra_origin: "p" } })).toBe("p");
  });
});
