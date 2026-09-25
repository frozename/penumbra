import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import * as lib from "../src/index.ts";

const PACKAGE_DIR = dirname(import.meta.dir);

describe("[B10] single-owner guarantees", () => {
  test("[B10] two imports of the package produce independent pool instances", async () => {
    const entryUrl = join(PACKAGE_DIR, "src", "index.ts");
    const first = (await import(entryUrl)) as typeof lib;
    const second = (await import(`${entryUrl}?second-import`)) as typeof lib;
    const poolA = first.createAcpWarmPool();
    const poolB = second.createAcpWarmPool();
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let killed = false;
      poolA.deposit(
        {
          agentKey: "k",
          env: { PATH: "/usr/bin" },
          credentials: { credentialScope: "s" },
          specHash: "h",
        },
        {
          client: {},
          handle: {
            stdin,
            stdout,
            kill: () => {
              killed = true;
            },
            exited: Promise.resolve(null),
            pid: undefined,
            getStderrTail: () => "",
          },
        },
      );
      expect(poolA.diagnostics().live).toBe(1);
      expect(poolB.diagnostics().live).toBe(0);
      poolB.shutdown();
      expect(killed).toBe(false);
      poolA.shutdown();
      expect(killed).toBe(true);
    } finally {
      poolA.shutdown();
      poolB.shutdown();
    }
  });

  test("[B10] the package namespace contains exactly the documented exports", () => {
    const keys = Object.keys(lib).sort();
    const documented = [
      "AcpTransportClosedError",
      "HostInputError",
      "StdioAcpClient",
      "StdioAcpPermissionContext",
      "createAcpWarmPool",
      "handleStdioAcpPermissionRequest",
      "initializeAcpSession",
      "poolKeyFor",
      "runProcess",
      "selectConfigOption",
      "selectTrustAllOption",
      "startStdioAcpServer",
      "superviseProcess",
    ];
    for (const name of documented) {
      expect(keys).toContain(name);
    }
    const runtimeKeys = keys.filter(
      (k) => typeof (lib as Record<string, unknown>)[k] !== "undefined",
    );
    expect(runtimeKeys).toEqual([...documented].sort());
  });

  test("[B10] the closure audit reports zero mutable module-scope bindings", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "scripts/closure-audit.ts", "--src"],
      cwd: PACKAGE_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('"mutableBindings": 0');
  });
});
