import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOpencodeConsoleConfig } from "@src/usage-readers/opencode-console-config.js";

function makeQuotasDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-console-config-"));
  writeFileSync(join(dir, "quotas.yaml"), yaml);
  return dir;
}

const VALID = `providers:
  - name: opencode-go
    opencode_console:
      workspace_id: "ws-test"
      base_url: "https://opencode.ai"
      cookie_file: "secrets/opencode-go.cookie"
`;

describe("loadOpencodeConsoleConfig", () => {
  test("resolves console config + relative cookie_file against config dir", () => {
    const dir = makeQuotasDir(VALID);
    const cfg = loadOpencodeConsoleConfig({ configDir: dir });
    expect(cfg?.workspace_id).toBe("ws-test");
    expect(cfg?.base_url).toBe("https://opencode.ai");
    expect(cfg?.cookie_file).toBe(join(dir, "secrets/opencode-go.cookie"));
  });

  test("leaves an absolute cookie_file unchanged", () => {
    const dir = makeQuotasDir(VALID.replace("secrets/opencode-go.cookie", "/abs/oc.cookie"));
    expect(loadOpencodeConsoleConfig({ configDir: dir })?.cookie_file).toBe("/abs/oc.cookie");
  });

  test("returns null when the opencode-go provider is absent", () => {
    const dir = makeQuotasDir(`providers:\n  - name: anthropic\n    quota_usd_per_24h: 50\n`);
    expect(loadOpencodeConsoleConfig({ configDir: dir })).toBeNull();
  });

  test("returns null when the opencode_console block is absent", () => {
    const dir = makeQuotasDir(`providers:\n  - name: opencode-go\n    quota_usd_per_24h: 10\n`);
    expect(loadOpencodeConsoleConfig({ configDir: dir })).toBeNull();
  });

  test("returns null when quotas.yaml is missing", () => {
    expect(
      loadOpencodeConsoleConfig({ configDir: join(tmpdir(), "no-such-penumbra-dir-xyz") }),
    ).toBeNull();
  });
});
