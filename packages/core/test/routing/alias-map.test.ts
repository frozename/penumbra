import { describe, expect, test } from "bun:test";

import { buildAliasIndex, reconcileAliases } from "@src/routing/alias-map.js";
import type { AaModel, AaModelSnapshot } from "@src/routing/schemas.js";

function aaModel(overrides: {
  id: string;
  name?: string;
  creatorSlug: string;
  slug: string;
}): AaModel {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.slug,
    slug: overrides.slug,
    model_creator: {
      id: `${overrides.creatorSlug}-creator`,
      name: overrides.creatorSlug,
      slug: overrides.creatorSlug,
    },
    evaluations: {},
    pricing: {},
  };
}

function snapshot(models: AaModel[]): AaModelSnapshot {
  return {
    collectedAt: "2026-08-24T00:00:00.000Z",
    models,
  };
}

describe("routing alias-map reconciliation", () => {
  test("a seat with no configured alias is marked no_alias_configured, never paired with the nearest AA model", () => {
    const result = reconcileAliases(
      buildAliasIndex({}),
      snapshot([aaModel({ id: "aa-1", creatorSlug: "openai", slug: "gpt-5" })]),
      ["codex-seat"],
    );

    expect(result).toEqual({
      "codex-seat": { unmatched: "no_alias_configured" },
    });
  });

  test("two seats sharing one (aa_creator, aa_slug) BOTH resolve to the same matched model", () => {
    const matched = aaModel({ id: "aa-1", creatorSlug: "openai", slug: "gpt-5" });
    const result = reconcileAliases(
      buildAliasIndex({
        "planner-seat": { aa_creator: "openai", aa_slug: "gpt-5" },
        "executor-seat": { aa_creator: "openai", aa_slug: "gpt-5" },
      }),
      snapshot([matched]),
      ["planner-seat", "executor-seat"],
    );

    expect(result).toEqual({
      "planner-seat": { matched },
      "executor-seat": { matched },
    });
  });

  test("an alias matching zero snapshot models is unmatched with alias_matches_no_snapshot_model", () => {
    const result = reconcileAliases(
      buildAliasIndex({
        "codex-seat": { aa_creator: "openai", aa_slug: "gpt-5" },
      }),
      snapshot([aaModel({ id: "aa-1", creatorSlug: "anthropic", slug: "claude-sonnet" })]),
      ["codex-seat"],
    );

    expect(result).toEqual({
      "codex-seat": { unmatched: "alias_matches_no_snapshot_model" },
    });
  });

  test("an alias matching multiple snapshot models (duplicate slug rows in the snapshot) is unmatched with alias_matches_multiple_snapshot_models -- never silently picks one", () => {
    const duplicateA = aaModel({ id: "aa-1", creatorSlug: "openai", slug: "gpt-5" });
    const duplicateB = aaModel({ id: "aa-2", creatorSlug: "openai", slug: "gpt-5" });

    const result = reconcileAliases(
      buildAliasIndex({
        "codex-seat": { aa_creator: "openai", aa_slug: "gpt-5" },
      }),
      snapshot([duplicateA, duplicateB]),
      ["codex-seat"],
    );

    expect(result).toEqual({
      "codex-seat": { unmatched: "alias_matches_multiple_snapshot_models" },
    });
  });

  test("'OpenAI' creator slug in the snapshot matches a canonical 'openai' alias entry", () => {
    const matched = aaModel({ id: "aa-1", creatorSlug: "OpenAI", slug: "gpt-5" });
    const result = reconcileAliases(
      buildAliasIndex({
        "codex-seat": { aa_creator: "openai", aa_slug: "gpt-5" },
      }),
      snapshot([matched]),
      ["codex-seat"],
    );

    expect(result).toEqual({
      "codex-seat": { matched },
    });
  });

  test("reconcile output is keyed by seat name, never by AA slug", () => {
    const matched = aaModel({ id: "aa-1", creatorSlug: "openai", slug: "gpt-5" });
    const result = reconcileAliases(
      buildAliasIndex({
        "codex-seat": { aa_creator: "openai", aa_slug: "gpt-5" },
      }),
      snapshot([matched]),
      ["codex-seat"],
    );

    expect(Object.keys(result)).toEqual(["codex-seat"]);
    expect(Object.hasOwn(result, "gpt-5")).toBe(false);
  });

  test("identical inputs produce byte-identical output", () => {
    const aliases = buildAliasIndex({
      "codex-seat": { aa_creator: "openai", aa_slug: "gpt-5" },
      "claude-seat": { aa_creator: "anthropic", aa_slug: "claude-sonnet" },
    });
    const aaSnapshot = snapshot([
      aaModel({ id: "aa-1", creatorSlug: "OpenAI", slug: "gpt-5" }),
      aaModel({ id: "aa-2", creatorSlug: "anthropic", slug: "claude-sonnet" }),
    ]);
    const seatNames = ["codex-seat", "claude-seat", "missing-seat"];

    const first = JSON.stringify(reconcileAliases(aliases, aaSnapshot, seatNames));
    const second = JSON.stringify(reconcileAliases(aliases, aaSnapshot, seatNames));

    expect(first).toBe(second);
  });
});
