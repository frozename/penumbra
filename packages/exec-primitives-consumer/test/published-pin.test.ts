import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCK_ENTRY } from "../src/pin.ts";

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

describe("@novaproto/exec-primitives registry pin", () => {
  test("manifest pins the exact published version", async () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages/exec-primitives-consumer/package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    expect(manifest.devDependencies?.["@novaproto/exec-primitives"]).toBe("0.1.0");
  });

  test("bun.lock resolves the pin to the published tarball integrity", async () => {
    const lock = readFileSync(join(repoRoot, "bun.lock"), "utf8");
    expect(lock).toContain(LOCK_ENTRY);
  });

  test("resolves to an installed registry copy, not a workspace or sibling checkout", async () => {
    const mod = await import("@novaproto/exec-primitives");
    const resolved = realpathSync(
      fileURLToPath(import.meta.resolve("@novaproto/exec-primitives")),
    );
    expect(resolved).toContain("/node_modules/.bun/@novaproto+exec-primitives@0.1.0/");
    const pkgDir = dirname(dirname(resolved));
    const installed = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(installed.name).toBe("@novaproto/exec-primitives");
    expect(installed.version).toBe("0.1.0");
    expect(typeof mod.runProcess).toBe("function");
  });

  test("runs a real process through the published supervisor", async () => {
    const { runProcess } = await import("@novaproto/exec-primitives");
    const result = await runProcess({
      command: "sh",
      args: ["-c", 'printf "pin-ok"'],
      cwd: repoRoot,
      env: { PATH: process.env["PATH"] ?? "" },
      signal: new AbortController().signal,
      cancelGraceMs: 5_000,
      watchdogMs: 10_000,
    });
    expect(result.stdout).toBe("pin-ok");
    expect(result.exit.code).toBe(0);
  });
});
