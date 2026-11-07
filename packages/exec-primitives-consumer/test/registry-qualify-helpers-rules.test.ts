import { describe, expect, test } from "bun:test";

import {
  classifyWorktree,
  hasLockEntry,
  parseBunSummary,
  validatePublishedManifest,
} from "../scripts/registry-qualify-helpers.ts";

const base = { name: "@novaproto/exec-primitives", version: "0.1.0", license: "MIT" };

describe("registry qualify helper rules", () => {
  test("flags a manifest name outside the pinned package", () => {
    expect(validatePublishedManifest({ ...base, name: "@novaproto/other" })).toEqual([
      "name/version",
    ]);
  });

  test("flags a manifest version outside the pinned release", () => {
    expect(validatePublishedManifest({ ...base, version: "0.2.0" })).toEqual(["name/version"]);
  });

  test("flags a present private key even when false", () => {
    expect(validatePublishedManifest({ ...base, private: false })).toEqual(["private"]);
  });

  test("flags a license other than MIT", () => {
    expect(validatePublishedManifest({ ...base, license: "ISC" })).toEqual(["license"]);
  });

  test("flags a manifest with no license key", () => {
    expect(validatePublishedManifest({ name: base.name, version: base.version })).toEqual([
      "license",
    ]);
  });

  test("flags present dependency keys even when empty", () => {
    expect(
      validatePublishedManifest({ ...base, peerDependencies: {}, optionalDependencies: {} }),
    ).toEqual(["peerDependencies", "optionalDependencies"]);
  });

  test("flags a workspace protocol token in dependency values", () => {
    expect(validatePublishedManifest({ ...base, devDependencies: { a: "workspace:^" } })).toEqual([
      "workspace:",
    ]);
  });

  test("flags a file protocol token in dependency values", () => {
    expect(validatePublishedManifest({ ...base, devDependencies: { a: "file:../a" } })).toEqual([
      "file:",
    ]);
  });

  test("flags a link protocol token in dependency values", () => {
    expect(validatePublishedManifest({ ...base, devDependencies: { a: "link:../a" } })).toEqual([
      "link:",
    ]);
  });

  test("flags a @penumbra scoped token in dependency values", () => {
    expect(
      validatePublishedManifest({ ...base, devDependencies: { "@penumbra/core": "1.0.0" } }),
    ).toEqual(["@penumbra/"]);
  });

  test("flags a 0.0.0 placeholder token in dependency values", () => {
    expect(validatePublishedManifest({ ...base, devDependencies: { a: "0.0.0" } })).toEqual([
      "0.0.0",
    ]);
  });

  test("classifies whitespace-only porcelain output as clean", () => {
    expect(classifyWorktree({ exit: 0, stdout: "  \n\t\n" })).toBe("clean");
  });

  test("classifies a non-zero worktree exit as unreadable", () => {
    expect(classifyWorktree({ exit: 1, stdout: " M a.ts\n" })).toBe("unreadable");
  });

  test("ignores pass lines with a non-numeric prefix", () => {
    expect(parseBunSummary(" 5 pass\n 0 fail\nRan 5 tests across 2 files\nnote: 9 pass")).toEqual({
      pass: 5,
      fail: 0,
      files: 2,
    });
  });

  test("ignores pass lines with trailing text", () => {
    expect(
      parseBunSummary(" 5 pass\n 0 fail\nRan 5 tests across 2 files\n 7 pass trailing"),
    ).toEqual({ pass: 5, fail: 0, files: 2 });
  });

  test("parses summary lines without leading spaces and singular nouns", () => {
    expect(parseBunSummary("3 pass\n1 fail\nRan 1 test across 1 file")).toEqual({
      pass: 3,
      fail: 1,
      files: 1,
    });
  });

  test("finds an explicit lock entry inside surrounding text", () => {
    expect(hasLockEntry("prefix custom-entry suffix", "custom-entry")).toBe(true);
  });

  test("returns false when the explicit lock entry is absent", () => {
    expect(hasLockEntry("prefix suffix", "custom-entry")).toBe(false);
  });
});
