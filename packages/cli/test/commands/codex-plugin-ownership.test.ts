import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";

import {
  type CodexPluginOwnership,
  CodexPluginSetupError,
  type CodexSetupHost,
  type CodexSetupHostResult,
  createPluginRecord,
  isValidPluginRecord,
  pluginOwnership,
  type PluginRecord,
  requirePluginInstalled,
  requireSupportedPlugin,
} from "@src/commands/codex-plugin-ownership.js";

// An absolute POSIX package dir; the marketplace root is always derived with dirname().
const PACKAGE_DIR = "/opt/pkgs/penumbra";
const MARKETPLACE_ROOT = dirname(PACKAGE_DIR);
const PLUGIN_ID = "penumbra@penumbra-local";
const DEFAULT_UNAVAILABLE = "Codex plugin installation support is unavailable";
const MISSING_ARGV = "supported plugin adapter is missing its verified identifier or argv arrays";
const NOT_CONFIRMED = "verified Codex plugin adapter did not confirm installation";
const UNEXPECTED_MARKETPLACE = "plugin adapter returned ownership for an unexpected marketplace";

type HostPlugin = CodexSetupHost["plugin"];
type RequiredPluginField = "identifier" | "installArgv" | "statusArgv" | "uninstallArgv";

function hostWith(plugin: HostPlugin): CodexSetupHost {
  return {
    plugin,
    invoke: (): Promise<CodexSetupHostResult> => Promise.resolve({ ok: true }),
  };
}

function supportedPlugin(): HostPlugin {
  return {
    state: "supported",
    identifier: PLUGIN_ID,
    installArgv: ["plugin", "install"],
    statusArgv: ["plugin", "status"],
    uninstallArgv: ["plugin", "uninstall"],
  };
}

function supportedPluginWithout(field: RequiredPluginField): HostPlugin {
  const plugin = supportedPlugin();
  Reflect.deleteProperty(plugin, field);
  return plugin;
}

function ownershipFor(pluginOwned: boolean): CodexPluginOwnership {
  return {
    identifier: PLUGIN_ID,
    marketplaceName: "penumbra-local",
    marketplaceRoot: MARKETPLACE_ROOT,
    pluginRoot: PACKAGE_DIR,
    marketplaceOwned: true,
    pluginOwned,
  };
}

function ownershipWithout(field: keyof CodexPluginOwnership): Record<string, unknown> {
  const value: Record<string, unknown> = { ...ownershipFor(true) };
  Reflect.deleteProperty(value, field);
  return value;
}

function setupErrorFrom(run: () => unknown): CodexPluginSetupError {
  try {
    run();
  } catch (error) {
    if (error instanceof CodexPluginSetupError) return error;
    throw error;
  }
  throw new Error("expected a CodexPluginSetupError");
}

describe("requireSupportedPlugin", () => {
  test("an undefined host throws the default unavailable error", () => {
    const error = setupErrorFrom(() => requireSupportedPlugin(undefined));
    expect(error.message).toBe(DEFAULT_UNAVAILABLE);
    expect(error.state).toBe("unavailable");
  });

  test("an unknown plugin keeps its detail and the unknown state", () => {
    const host = hostWith({ state: "unknown", detail: "probe failed" });
    const error = setupErrorFrom(() => requireSupportedPlugin(host));
    expect(error.message).toBe("probe failed");
    expect(error.state).toBe("unknown");
  });

  test("an unavailable plugin without detail throws the default message", () => {
    const error = setupErrorFrom(() => requireSupportedPlugin(hostWith({ state: "unavailable" })));
    expect(error.message).toBe(DEFAULT_UNAVAILABLE);
    expect(error.state).toBe("unavailable");
  });

  const incomplete: { name: string; plugin: HostPlugin }[] = [
    { name: "no identifier", plugin: supportedPluginWithout("identifier") },
    { name: "an empty identifier", plugin: { ...supportedPlugin(), identifier: "" } },
    { name: "no installArgv", plugin: supportedPluginWithout("installArgv") },
    { name: "no statusArgv", plugin: supportedPluginWithout("statusArgv") },
    { name: "no uninstallArgv", plugin: supportedPluginWithout("uninstallArgv") },
  ];
  for (const { name, plugin } of incomplete) {
    test(`a supported plugin with ${name} is rejected as unavailable`, () => {
      const error = setupErrorFrom(() => requireSupportedPlugin(hostWith(plugin)));
      expect(error.message).toBe(MISSING_ARGV);
      expect(error.state).toBe("unavailable");
    });
  }

  test("a fully populated supported plugin returns the same host and plugin", () => {
    const host = hostWith(supportedPlugin());
    const verified = requireSupportedPlugin(host);
    expect(verified.host).toBe(host);
    expect(Object.is(verified.plugin, host.plugin)).toBe(true);
  });
});

describe("requirePluginInstalled", () => {
  test("an ok result with installed true passes", () => {
    expect(() => {
      requirePluginInstalled({ ok: true, installed: true });
    }).not.toThrow();
  });

  test("an ok result without installed throws the default message", () => {
    const error = setupErrorFrom(() => {
      requirePluginInstalled({ ok: true });
    });
    expect(error.message).toBe(NOT_CONFIRMED);
    expect(error.state).toBe("unavailable");
  });

  test("an ok result with installed false throws the default message", () => {
    expect(() => {
      requirePluginInstalled({ ok: true, installed: false });
    }).toThrow(NOT_CONFIRMED);
  });

  test("a failed result throws its detail even when installed is true", () => {
    expect(() => {
      requirePluginInstalled({ ok: false, installed: true, detail: "adapter refused" });
    }).toThrow("adapter refused");
  });

  test("installed must be the boolean true, not the string", () => {
    const result = { ok: true, installed: "true" } as unknown as CodexSetupHostResult;
    expect(() => {
      requirePluginInstalled(result);
    }).toThrow(NOT_CONFIRMED);
  });
});

describe("pluginOwnership", () => {
  const rejected: { name: string; value: unknown }[] = [
    { name: "undefined", value: undefined },
    { name: "null", value: null },
    { name: "an array", value: [ownershipFor(true)] },
    { name: "marketplaceOwned false", value: { ...ownershipFor(true), marketplaceOwned: false } },
    { name: "no pluginOwned", value: ownershipWithout("pluginOwned") },
    { name: "a string pluginOwned", value: { ...ownershipFor(true), pluginOwned: "yes" } },
    { name: "no identifier", value: ownershipWithout("identifier") },
    { name: "no marketplaceName", value: ownershipWithout("marketplaceName") },
    { name: "no marketplaceRoot", value: ownershipWithout("marketplaceRoot") },
    { name: "no pluginRoot", value: ownershipWithout("pluginRoot") },
  ];
  for (const { name, value } of rejected) {
    test(`returns undefined for ${name}`, () => {
      expect(pluginOwnership(value as PluginRecord | undefined)).toBeUndefined();
    });
  }

  test("returns a complete record as the same object", () => {
    const owned = ownershipFor(true);
    const notOwned = ownershipFor(false);
    expect(pluginOwnership(owned)).toBe(owned);
    expect(pluginOwnership(notOwned)).toBe(notOwned);
  });
});

describe("createPluginRecord", () => {
  test("without ownership returns exactly the identifier", () => {
    expect(createPluginRecord(PACKAGE_DIR, PLUGIN_ID, undefined)).toStrictEqual({
      identifier: PLUGIN_ID,
    });
  });

  test("returns verified penumbra-local ownership as the same object", () => {
    const owned = ownershipFor(true);
    const notOwned = ownershipFor(false);
    expect(createPluginRecord(PACKAGE_DIR, PLUGIN_ID, owned)).toBe(owned);
    expect(createPluginRecord(PACKAGE_DIR, PLUGIN_ID, notOwned)).toBe(notOwned);
  });

  const mismatched: { name: string; ownership: CodexPluginOwnership }[] = [
    {
      name: "identifier",
      ownership: { ...ownershipFor(true), identifier: "other@penumbra-local" },
    },
    { name: "marketplaceName", ownership: { ...ownershipFor(true), marketplaceName: "other" } },
    { name: "marketplaceRoot", ownership: { ...ownershipFor(true), marketplaceRoot: "/opt" } },
    { name: "pluginRoot", ownership: { ...ownershipFor(true), pluginRoot: "/opt/pkgs/other" } },
  ];
  for (const { name, ownership } of mismatched) {
    test(`throws when the ${name} does not match`, () => {
      expect(() => createPluginRecord(PACKAGE_DIR, PLUGIN_ID, ownership)).toThrow(
        UNEXPECTED_MARKETPLACE,
      );
    });
  }
});

describe("isValidPluginRecord", () => {
  const invalid: { name: string; value: unknown }[] = [
    { name: "null", value: null },
    { name: "a string", value: PLUGIN_ID },
    { name: "an array", value: [{ identifier: PLUGIN_ID }] },
    { name: "a record without identifier", value: {} },
    { name: "an empty identifier", value: { identifier: "" } },
    { name: "a numeric identifier", value: { identifier: 7 } },
    {
      name: "partial ownership fields",
      value: { identifier: PLUGIN_ID, marketplaceName: "penumbra-local" },
    },
    {
      name: "another identifier with valid ownership",
      value: { ...ownershipFor(true), identifier: "other@penumbra-local" },
    },
    { name: "marketplaceName other", value: { ...ownershipFor(true), marketplaceName: "other" } },
    { name: "marketplaceRoot /opt", value: { ...ownershipFor(true), marketplaceRoot: "/opt" } },
    {
      name: "pluginRoot /opt/pkgs/other",
      value: { ...ownershipFor(true), pluginRoot: "/opt/pkgs/other" },
    },
    { name: "marketplaceOwned false", value: { ...ownershipFor(true), marketplaceOwned: false } },
    { name: "pluginOwned yes", value: { ...ownershipFor(true), pluginOwned: "yes" } },
  ];
  for (const { name, value } of invalid) {
    test(`rejects ${name}`, () => {
      expect(isValidPluginRecord(value, PACKAGE_DIR)).toBe(false);
    });
  }

  test("accepts a legacy record with only an identifier", () => {
    expect(isValidPluginRecord({ identifier: "anything" }, PACKAGE_DIR)).toBe(true);
  });

  test("accepts the full penumbra-local ownership record", () => {
    expect(isValidPluginRecord(ownershipFor(true), PACKAGE_DIR)).toBe(true);
    expect(isValidPluginRecord(ownershipFor(false), PACKAGE_DIR)).toBe(true);
  });
});
