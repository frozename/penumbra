import { expect, test } from "bun:test";

async function buildInstructions(): Promise<string> {
  const agents = await Bun.file(new URL("../AGENTS.md", import.meta.url)).text();
  return agents.split("## Quick reference")[1]?.split("## Conventions")[0] ?? "";
}

test("build instructions prepare the exact model in fresh worktrees before embedder or e2e tests", async () => {
  const instructions = await buildInstructions();
  expect(instructions).toContain("fresh worktrees");
  expect(instructions).toContain("bun scripts/fetch-embedder-model.ts");
  expect(instructions).toContain("once before running embedder or e2e tests");
});

test("build instructions require a stored-vector re-embed migration before a fastembed bump", async () => {
  const instructions = await buildInstructions();
  expect(instructions).toContain("Never bump fastembed without a re-embed migration");
  expect(instructions).toContain("vectors change");
});
