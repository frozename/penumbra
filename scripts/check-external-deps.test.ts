import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CheckedDep,
  collectCheckedDeps,
  describeUnresolvedDeps,
  findUnresolvedDeps,
} from "./check-external-deps.js";

function fixture(manifests: Record<string, unknown>): string[] {
  const root = mkdtempSync(join(tmpdir(), "penumbra-dep-check-"));
  const dirs: string[] = [];
  for (const [name, manifest] of Object.entries(manifests)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    dirs.push(dir);
  }
  return dirs;
}

test("collectCheckedDeps picks up non-registry specs and required externals only", () => {
  const dirs = fixture({
    core: {
      dependencies: { "@novaproto/contracts": "^0.1.0", zod: "^3" },
      devDependencies: { typescript: "^5" },
    },
    mcp: { dependencies: { "@nova/mcp-shared": "file:../../../nova/packages/mcp-shared" } },
  });

  const names = collectCheckedDeps(dirs)
    .map((d) => d.name)
    .sort();

  expect(names).toEqual(["@nova/mcp-shared", "@novaproto/contracts"]);
});

test("collectCheckedDeps skips directories without a manifest", () => {
  expect(collectCheckedDeps([join(tmpdir(), "penumbra-does-not-exist")])).toEqual([]);
});

test("findUnresolvedDeps reports only the deps that fail to resolve", () => {
  const deps: CheckedDep[] = [
    { packageDir: "/repo/packages/core", name: "ok", spec: "^1" },
    { packageDir: "/repo/packages/mcp", name: "broken", spec: "file:../../../nova" },
  ];

  const unresolved = findUnresolvedDeps(deps, (dep) => dep.name === "ok");

  expect(unresolved).toEqual([deps[1]]);
});

test("describeUnresolvedDeps names the dependency and the declaring package", () => {
  const message = describeUnresolvedDeps([
    { packageDir: "/repo/packages/mcp", name: "@novaproto/mcp-shared", spec: "^0.1.0" },
  ]);

  expect(message).toContain("@novaproto/mcp-shared@^0.1.0");
  expect(message).toContain("/repo/packages/mcp");
  expect(message).toContain("can exit 0 even when a dependency fails to link");
});
