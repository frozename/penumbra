import { describe, expect, test } from "bun:test";

import {
  buildClientCapabilities,
  resolvePermissionMode,
  type StdioAcpOptions,
} from "@src/adapters/stdio-acp.js";
import type { DispatchInput } from "@src/sdk/adapter.js";

function baseOpts(extra: Partial<StdioAcpOptions> = {}): StdioAcpOptions {
  return { binary: "mock-acp", ...extra };
}

function baseInput(extra: Partial<DispatchInput> = {}): DispatchInput {
  return {
    prompt: "x",
    conversation: { id: "c", project_id: null },
    config: {},
    signal: new AbortController().signal,
    ...extra,
  };
}

describe("resolvePermissionMode", () => {
  test("explicit opts.permissionMode wins over trust_mode", () => {
    expect(resolvePermissionMode({ permissionMode: "plan" }, { trust_mode: "all" })).toBe("plan");
  });

  test("trust_mode=all → bypassPermissions when opts unset", () => {
    expect(resolvePermissionMode({}, { trust_mode: "all" })).toBe("bypassPermissions");
  });

  test("trust_mode=config → undefined", () => {
    expect(resolvePermissionMode({}, { trust_mode: "config" })).toBeUndefined();
  });

  test("no opts + no input → undefined", () => {
    expect(resolvePermissionMode({})).toBeUndefined();
  });
});

describe("buildClientCapabilities trust hint", () => {
  test("trust_mode=all advertises bypassPermissions on top-level + _meta", () => {
    const caps = buildClientCapabilities(baseOpts(), baseInput({ trust_mode: "all" }));
    expect(caps.permission).toEqual({ mode: "bypassPermissions" });
    expect(caps._meta).toEqual({
      permissionMode: "bypassPermissions",
      permission: { mode: "bypassPermissions" },
    });
  });

  test("trust_mode=config emits no permission surface", () => {
    const caps = buildClientCapabilities(baseOpts(), baseInput({ trust_mode: "config" }));
    expect(caps.permission).toBeUndefined();
    expect(caps._meta).toBeUndefined();
  });

  test("explicit opts.permissionMode overrides trust_mode", () => {
    const caps = buildClientCapabilities(
      baseOpts({ permissionMode: "acceptEdits" }),
      baseInput({ trust_mode: "config" }),
    );
    expect(caps.permission).toEqual({ mode: "acceptEdits" });
    expect(caps._meta?.permissionMode).toBe("acceptEdits");
  });

  test("fs/terminal capabilities still flow alongside permission hint", () => {
    const caps = buildClientCapabilities(
      baseOpts({ fsReadTextFile: true, fsWriteTextFile: true, terminal: true }),
      baseInput({ trust_mode: "all" }),
    );
    expect(caps.fs).toEqual({ readTextFile: true, writeTextFile: true });
    expect(caps.terminal).toBe(true);
    expect(caps.permission?.mode).toBe("bypassPermissions");
  });

  test("no input + no opts → bare capabilities (back-compat)", () => {
    const caps = buildClientCapabilities(baseOpts());
    expect(caps).toEqual({});
  });
});
