import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const reason =
  "Newer fastembed releases change the vectors for the same text; a bump needs a full re-embed migration of stored vectors first.";
const coreManifest = new URL("../../package.json", import.meta.url);
const requireFromCore = createRequire(coreManifest);

test("fastembed declaration is pinned to the stored-vector version", async () => {
  const manifest = (await Bun.file(coreManifest).json()) as {
    dependencies: { fastembed: string };
  };
  expect(manifest.dependencies.fastembed, reason).toBe("1.14.4");
});

test("installed fastembed matches the stored-vector version", async () => {
  const manifest = (await Bun.file(requireFromCore.resolve("fastembed/package.json")).json()) as {
    version: string;
  };
  expect(manifest.version, reason).toBe("1.14.4");
});
