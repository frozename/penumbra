import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const { parse } = requireFromCore("yaml") as { parse: (source: string) => unknown };

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  jobs: { check: { permissions?: Record<string, string>; steps: Step[] } };
};

async function workflow(): Promise<Workflow> {
  return parse(
    await Bun.file(new URL("../.github/workflows/check.yml", import.meta.url)).text(),
  ) as Workflow;
}

const stepName = "embedder model (pinned release asset, sha256-verified)";

test("CI verifies the pinned model immediately after install and before typecheck", async () => {
  const steps = (await workflow()).jobs.check.steps;
  const index = steps.findIndex((step) => step.name === stepName);
  expect(index, "CI must restore the exact stored-vector model before tests").toBeGreaterThan(0);
  expect(steps[index - 1]?.name).toBe("install");
  expect(steps[index + 1]?.name).toBe("typecheck");
  expect(steps[index]?.run).toBe("bun scripts/fetch-embedder-model.ts");
  expect(steps.filter((step) => step.name === stepName)).toHaveLength(1);
});

test("CI authenticates the private release download with contents read permission", async () => {
  const job = (await workflow()).jobs.check;
  const step = job.steps.find((entry) => entry.name === stepName);
  expect(step?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
  expect(job.permissions).toEqual({ contents: "read" });
});
