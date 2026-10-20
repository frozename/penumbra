import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TYPESAFE_SYSTEMONE_PATH } from "../src/index.js";

const PKG_ROOT = join(import.meta.dir, "..");
const ALLOWED_RUNTIME_DEPS = ["@penumbra/core", "zod"];
const RAW_ENV = /\b(?:process\.env|Bun\.env)\b/;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".ts"))
    .map((rel) => join(dir, rel));
}

test("exports the systemone wire path", () => {
  expect(TYPESAFE_SYSTEMONE_PATH).toBe("/v1/systemone");
});

test("declares no runtime dependency beyond @penumbra/core and zod, and no vendor package", () => {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as Manifest;
  expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(ALLOWED_RUNTIME_DEPS);
  expect(manifest.peerDependencies).toBeUndefined();
  const all = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  expect(all.filter((name) => name.startsWith("@typesafe-ai/"))).toEqual([]);
});

test("src never reads the raw environment", () => {
  const offenders = listTsFiles(join(PKG_ROOT, "src")).filter((file) =>
    RAW_ENV.test(readFileSync(file, "utf8")),
  );
  expect(offenders).toEqual([]);
});
