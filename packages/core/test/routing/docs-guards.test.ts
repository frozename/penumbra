import {
  loadModelAliasMapFromDir,
  loadTaskRouterConfigFromDir,
  TaskRouterConfigSchema,
} from "@penumbra/config";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// These guards check file presence and simple textual consistency only.
// They do not prove prose accuracy, runtime behavior, or semantic completeness.
/**
 * Resolves the repo root from this test file's location rather than
 * process.cwd(), which is unreliable when bun test runs from a worktree.
 * Mirrors the convention in schemas/event-coverage.test.ts. The AGENTS.md
 * check catches a silently wrong resolution (e.g. after a directory move)
 * before it reads the wrong docs/ tree.
 */
function repoRoot(): string {
  const root = resolve(import.meta.dir, "../../../../");
  if (!existsSync(join(root, "AGENTS.md"))) {
    throw new Error(`resolved repo root does not contain AGENTS.md: ${root}`);
  }
  return root;
}

function readDoc(relPath: string): string {
  return readFileSync(join(repoRoot(), relPath), "utf8");
}

describe("router docs staleness guards", () => {
  test("every TaskRouterConfig weight key is documented in metrics.md", () => {
    const metricsDoc = readDoc("docs/router/metrics.md");
    const defaultWeights = TaskRouterConfigSchema.parse({}).weights;
    const missing = Object.keys(defaultWeights).filter(
      (weightKey) => !new RegExp(`\\b${weightKey}\\b`).test(metricsDoc),
    );
    expect(missing).toEqual([]);
  });

  test("every TaskRouterConfig mode enum value is documented in operations.md", () => {
    const operationsDoc = readDoc("docs/router/operations.md");
    const modeValues = TaskRouterConfigSchema.shape.mode.unwrap().options;
    const missing = modeValues.filter(
      (mode: string) => !new RegExp(`\\b${mode}\\b`).test(operationsDoc),
    );
    expect(missing).toEqual([]);
  });

  test("docs/router/examples/router.yaml parses through the real loadTaskRouterConfigFromDir loader", () => {
    const examplesDir = join(repoRoot(), "docs/router/examples");
    const router = loadTaskRouterConfigFromDir(examplesDir);
    expect(TaskRouterConfigSchema.safeParse(router).success).toBe(true);
    expect(["off", "recommend", "shadow", "auto"]).toContain(router.mode);
  });

  test("docs/router/examples/model-aliases.yaml parses through the real loadModelAliasMapFromDir loader and is non-empty", () => {
    const examplesDir = join(repoRoot(), "docs/router/examples");
    const aliases = loadModelAliasMapFromDir(examplesDir);
    expect(Object.keys(aliases).length).toBeGreaterThan(0);
    for (const [seat, alias] of Object.entries(aliases)) {
      expect(typeof seat).toBe("string");
      expect(alias.aa_creator.length).toBeGreaterThan(0);
      expect(alias.aa_slug.length).toBeGreaterThan(0);
    }
  });

  test("operations.md SQL example columns are present in decision-log INSERT text", () => {
    const operationsDoc = readDoc("docs/router/operations.md");
    const decisionLogSource = readDoc("packages/core/src/routing/decision-log.ts");
    const sqlColumns = [
      "decision_id",
      "ts",
      "handoff_id",
      "mode",
      "selected_agent",
      "selected_provider",
      "applied",
      "score",
      "confidence",
      "predicted_cost_usd",
      "predicted_latency_ms",
      "task_profile_json",
      "factors_json",
      "alternatives_json",
      "fallback_chain_json",
      "data_freshness_json",
      "explanation_json",
      "router_schema_version",
    ];

    const missing = sqlColumns.filter(
      (column) => operationsDoc.includes(column) && !decisionLogSource.includes(column),
    );
    expect(missing).toEqual([]);
  });
});
