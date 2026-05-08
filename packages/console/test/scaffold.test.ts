import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, "..", "package.json");

describe("@penumbra/console scaffold", () => {
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as {
    name?: string;
    private?: boolean;
    type?: string;
    dependencies?: Record<string, string>;
  };

  test("package.json parses with the expected name", () => {
    expect(pkg.name).toBe("@penumbra/console");
  });

  test("dependencies include react, zustand, and the workspace api-contract", () => {
    const deps = pkg.dependencies ?? {};
    expect(deps).toHaveProperty("react");
    expect(deps).toHaveProperty("zustand");
    expect(deps).toHaveProperty("@penumbra/api-contract");
  });
});
