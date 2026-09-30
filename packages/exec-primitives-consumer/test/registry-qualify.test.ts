import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeDigest,
  computeTarballHashes,
  hasLockEntry,
  parseBunSummary,
  validatePublishedManifest,
} from "../scripts/registry-qualify-helpers.ts";
import { INTEGRITY, LOCK_ENTRY } from "../src/pin.ts";

describe("registry qualification helpers", () => {
  test("uses the no-trailing-newline digest recipe", () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-primitives-digest-"));
    mkdirSync(join(dir, "dist", "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(dir, "dist", "src", "index.js"), "export const ok = true;\n");

    expect(computeDigest(dir)).toBe(
      "eb9fda5b14cc96eb95ec38417fffb31f73ddb804f82ba619678c4616fdc53689",
    );
  });

  test("parses the final bun summary counts", () => {
    const output = [
      " 1 pass",
      " 1 fail",
      "Ran 2 tests across 1 file",
      " 178 pass",
      " 0 fail",
      "Ran 178 tests across 15 files",
    ].join("\n");

    expect(parseBunSummary(output)).toEqual({ pass: 178, fail: 0, files: 15 });
  });

  test("rejects non-published manifest shapes", () => {
    expect(
      validatePublishedManifest({
        name: "@novaproto/exec-primitives",
        version: "0.1.0",
        license: "MIT",
      }),
    ).toEqual([]);
    expect(
      validatePublishedManifest({
        name: "@novaproto/exec-primitives",
        version: "0.1.0",
        private: true,
        license: "MIT",
        dependencies: {},
      }),
    ).toEqual(["private", "dependencies"]);
  });

  test("checks the exact registry lock entry", () => {
    expect(hasLockEntry(`${LOCK_ENTRY},\n`)).toBe(true);
    expect(hasLockEntry(LOCK_ENTRY.replace(INTEGRITY, "sha512-wrong"))).toBe(false);
  });

  test("computes tarball hash identities", () => {
    const hashes = computeTarballHashes(Buffer.from("fixture"));
    expect(hashes).toEqual({
      sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      sha1: "51cff3c1f0bc59f6187e7040cc12a4e9b1eca7aa",
      integrity:
        "sha512-lOlQ7aSocOZWXUThS5DxbAo4HNaTBFKcgfa9QIrxPFFVFrhBfgBfwxCT+qSxPekkNkVt0lKJqyhnw6V2+pSESQ==",
    });
  });
});
