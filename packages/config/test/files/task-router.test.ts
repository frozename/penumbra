import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadModelAliasMapFromDir,
  loadTaskRouterConfigFromDir,
  type ModelAliasMap,
  type TaskRouterConfig,
} from "@src/index.js";

import { removeRecursive, writeUtf8 } from "../_fs-helpers.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), "task-router-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeRecursive(dir);
  }
});

describe("task-router and model-alias boundary contract", () => {
  test("round-trips real YAML through the public loaders into defaulted frozen inferred types", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "router.yaml"),
      `
mode: shadow
weights:
  quality: 4
  speed: 3
thresholds:
  quality_floor: 0.72
  context_safety_margin_tokens: 8192
  max_fallbacks: 3
  judge_confidence_floor: 0.8
snapshot_ttl_seconds: 3600
max_predicted_cost_usd_per_dispatch: 0.75
`,
    );
    writeUtf8(
      join(dir, "model-aliases.yaml"),
      `
planner-primary:
  aa_creator: anthropic
  aa_slug: claude-sonnet-4-5
  reasoning_level: high
executor-fast:
  aa_creator: openai
  aa_slug: gpt-5.6
`,
    );

    const router = loadTaskRouterConfigFromDir(dir);
    const aliases = loadModelAliasMapFromDir(dir);
    const expectedRouter = {
      mode: "shadow",
      weights: {
        quality: 4,
        speed: 3,
        latency: 0.3,
        cost: 0.25,
        reliability: 0.75,
        affinity: 0.5,
        history: 0.6,
        quota: 0.2,
        uncertainty: 0.4,
        staleness: 0.1,
      },
      thresholds: {
        quality_floor: 0.72,
        context_safety_margin_tokens: 8192,
        max_fallbacks: 3,
        judge_confidence_floor: 0.8,
      },
      snapshot_ttl_seconds: 3600,
      max_predicted_cost_usd_per_dispatch: 0.75,
    } satisfies TaskRouterConfig;
    const expectedAliases = {
      "planner-primary": {
        aa_creator: "anthropic",
        aa_slug: "claude-sonnet-4-5",
        reasoning_level: "high",
      },
      "executor-fast": {
        aa_creator: "openai",
        aa_slug: "gpt-5.6",
      },
    } satisfies ModelAliasMap;

    expect(router).toEqual(expectedRouter);
    expect(aliases).toEqual(expectedAliases);
    expect(Object.isFrozen(router)).toBe(true);
    expect(Object.isFrozen(router.weights)).toBe(true);
    expect(Object.isFrozen(router.thresholds)).toBe(true);
    expect(Object.isFrozen(aliases)).toBe(true);
    expect(Object.isFrozen(aliases["planner-primary"])).toBe(true);
  });
});

describe("loadTaskRouterConfigFromDir", () => {
  test("returns mode off and never throws when router.yaml is absent", () => {
    const loaded = loadTaskRouterConfigFromDir(makeTempDir());

    expect(loaded.mode).toBe("off");
    expect(loaded.snapshot_ttl_seconds).toBe(86400);
    expect(loaded.weights.quality).toBeGreaterThan(
      Math.max(
        ...Object.entries(loaded.weights)
          .filter(([name]) => name !== "quality")
          .map(([, weight]) => weight),
      ),
    );
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  test("an empty router.yaml yields mode:'off' defaults", () => {
    const dir = makeTempDir();
    writeUtf8(join(dir, "router.yaml"), "");

    const loaded = loadTaskRouterConfigFromDir(dir);

    expect(loaded.mode).toBe("off");
    expect(loaded.snapshot_ttl_seconds).toBe(86400);
  });

  test("prefixes YAML parse errors with the router path and preserves the cause", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "router.yaml");
    writeUtf8(filePath, "mode: [\n");

    try {
      loadTaskRouterConfigFromDir(dir);
      throw new Error("expected loader to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toStartWith(`${filePath}: `);
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });

  test("rejects an unknown top-level key", () => {
    const dir = makeTempDir();
    writeUtf8(join(dir, "router.yaml"), "mode: off\nunknown: true\n");

    expect(() => loadTaskRouterConfigFromDir(dir)).toThrow(/unknown/);
  });

  test("rejects a mode value outside off, recommend, shadow, or auto", () => {
    const dir = makeTempDir();
    writeUtf8(join(dir, "router.yaml"), "mode: enabled\n");

    expect(() => loadTaskRouterConfigFromDir(dir)).toThrow(/mode/);
  });

  test("ignores router.yaml.bak beside router.yaml", () => {
    const dir = makeTempDir();
    writeUtf8(join(dir, "router.yaml"), "mode: recommend\n");
    writeUtf8(join(dir, "router.yaml.bak"), "mode: auto\nunknown: true\n");

    expect(loadTaskRouterConfigFromDir(dir).mode).toBe("recommend");
  });
});
