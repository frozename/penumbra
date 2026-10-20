import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { findUndeclaredWorkspaceImports } from "./lib/workspace-imports.js";

const findings = findUndeclaredWorkspaceImports(resolve(import.meta.dir, ".."));

test("root package declares workspace deps imported outside packages", () => {
  expect(findings.filter(({ owner }) => owner === "penumbra")).toEqual([]);
});

test("every workspace package declares its imported workspace deps", () => {
  expect(findings).toEqual([]);
});
