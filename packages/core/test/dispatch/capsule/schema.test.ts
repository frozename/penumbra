import { describe, expect, test } from "bun:test";

import {
  type AdvisoryItem,
  AdvisoryItemSchema,
  type Capsule,
  capsuleHashes,
  CapsuleRefusalSchema,
  CapsuleSchema,
  type LastError,
  refusal,
  RefusalCodeSchema,
} from "@src/dispatch/capsule/index.js";
import { digestOf } from "@src/evals/canonical.js";

const FULL_SHA_A = "a".repeat(40);
const FULL_SHA_C = "c".repeat(40);

function advisoryItem(id: string): AdvisoryItem {
  return {
    id,
    authority: "advisory",
    provenance: { source: "recall", ref: id },
    text: `advisory note ${id}`,
  };
}

function validCapsule(): Capsule {
  return {
    schema_version: 1,
    authoritative: {
      objective: "ship the capsule schema",
      acceptance_state: "open",
      base_sha: FULL_SHA_A,
      base_sha_verified: true,
      dependency_shas: [FULL_SHA_C],
      write_fence: ["src/a.ts"],
      essential_constraints: [{ id: "ec-1", text: "never force-push" }],
      check_recipes: [{ id: "t", command: "bun test x" }],
      tools: [{ id: "bun-cli", kind: "cli", command: "bun" }],
      artifact_handles: [{ id: "ah-1", kind: "log", uri: "artifact://test-log-1" }],
    },
    advisory: {
      memory: [advisoryItem("m1"), advisoryItem("m2")],
      log_excerpts: [advisoryItem("l1")],
    },
    token_report: { estimator: "tokenizer", used: 10, limit: 100 },
  };
}

function omitKey(obj: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map((item) => reverseKeys(item));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(record).toReversed()) {
      reversed[key] = reverseKeys(record[key]);
    }
    return reversed;
  }
  return value;
}

function lastError(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "test",
    excerpt: "boom",
    truncated: false,
    log_sha256: "b".repeat(64),
    ...overrides,
  };
}

describe("capsule schema", () => {
  test("accepts the valid capsule and rejects unknown keys", () => {
    const capsule = validCapsule();
    expect(CapsuleSchema.safeParse(capsule).success).toBe(true);
    expect(CapsuleSchema.safeParse({ ...capsule, extra: 1 }).success).toBe(false);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        authoritative: { ...capsule.authoritative, extra: 1 },
      }).success,
    ).toBe(false);
  });

  test("schema_version is the literal 1", () => {
    const capsule = validCapsule();
    expect(CapsuleSchema.safeParse(capsule).success).toBe(true);
    expect(CapsuleSchema.safeParse({ ...capsule, schema_version: 2 }).success).toBe(false);
    expect(CapsuleSchema.safeParse({ ...capsule, schema_version: "1" }).success).toBe(false);
  });

  const REQUIRED_AUTHORITATIVE_KEYS = [
    "objective",
    "acceptance_state",
    "base_sha",
    "base_sha_verified",
    "dependency_shas",
    "write_fence",
    "essential_constraints",
    "check_recipes",
    "tools",
    "artifact_handles",
  ] as const;

  test.each([...REQUIRED_AUTHORITATIVE_KEYS])("authoritative.%s is required", (key) => {
    const capsule = validCapsule();
    const authoritative = omitKey(capsule.authoritative, key);
    expect(CapsuleSchema.safeParse({ ...capsule, authoritative }).success).toBe(false);
  });

  test("SHAs must be full", () => {
    const capsule = validCapsule();
    expect(CapsuleSchema.safeParse(capsule).success).toBe(true);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        authoritative: { ...capsule.authoritative, base_sha: "abc123" },
      }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        authoritative: { ...capsule.authoritative, dependency_shas: ["abc"] },
      }).success,
    ).toBe(false);
  });

  test("base_sha_verified must be literal true", () => {
    const capsule = validCapsule();
    expect(CapsuleSchema.safeParse(capsule).success).toBe(true);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        authoritative: { ...capsule.authoritative, base_sha_verified: false },
      }).success,
    ).toBe(false);
  });

  test.each(["../x", "/abs", ".git/config"])("write_fence rejects %s", (badPath) => {
    const capsule = validCapsule();
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        authoritative: { ...capsule.authoritative, write_fence: [badPath] },
      }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        authoritative: { ...capsule.authoritative, write_fence: ["src/a.ts"] },
      }).success,
    ).toBe(true);
  });

  test("essential_constraints items require id and text", () => {
    const capsule = validCapsule();
    const constraint = capsule.authoritative.essential_constraints[0]!;
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        authoritative: {
          ...capsule.authoritative,
          essential_constraints: [omitKey(constraint, "id")],
        },
      }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        authoritative: {
          ...capsule.authoritative,
          essential_constraints: [omitKey(constraint, "text")],
        },
      }).success,
    ).toBe(false);
    expect(CapsuleSchema.safeParse(capsule).success).toBe(true);
  });

  test("advisory lane cannot carry authoritative items", () => {
    const capsule = validCapsule();
    const item = capsule.advisory.memory[0]!;
    expect(AdvisoryItemSchema.safeParse(item).success).toBe(true);
    expect(AdvisoryItemSchema.safeParse({ ...item, authority: "authoritative" }).success).toBe(
      false,
    );
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        advisory: {
          ...capsule.advisory,
          memory: [{ ...item, authority: "authoritative" }, ...capsule.advisory.memory.slice(1)],
        },
      }).success,
    ).toBe(false);
  });

  test("advisory items require provenance; repo_map is optional", () => {
    const capsule = validCapsule();
    expect(CapsuleSchema.safeParse(capsule).success).toBe(true);

    const memoryItem = capsule.advisory.memory[0]!;
    const logItem = capsule.advisory.log_excerpts[0]!;
    const repoMapItem = advisoryItem("rm1");
    const withRepoMap: Capsule = {
      ...capsule,
      advisory: { ...capsule.advisory, repo_map: repoMapItem },
    };
    expect(CapsuleSchema.safeParse(withRepoMap).success).toBe(true);

    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        advisory: {
          ...capsule.advisory,
          memory: [omitKey(memoryItem, "provenance"), ...capsule.advisory.memory.slice(1)],
        },
      }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        advisory: {
          ...capsule.advisory,
          log_excerpts: [omitKey(logItem, "provenance")],
        },
      }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({
        ...withRepoMap,
        advisory: { ...withRepoMap.advisory, repo_map: omitKey(repoMapItem, "provenance") },
      }).success,
    ).toBe(false);
  });

  test("advisory ids are unique per list", () => {
    const capsule = validCapsule();
    expect(CapsuleSchema.safeParse(capsule).success).toBe(true);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        advisory: {
          ...capsule.advisory,
          memory: [advisoryItem("m1"), advisoryItem("m1")],
        },
      }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        advisory: {
          ...capsule.advisory,
          log_excerpts: [advisoryItem("l1"), advisoryItem("l1")],
        },
      }).success,
    ).toBe(false);
  });

  test("last_error is optional and typed", () => {
    const capsule = validCapsule();
    expect(CapsuleSchema.safeParse({ ...capsule, last_error: lastError() }).success).toBe(true);
    expect(
      CapsuleSchema.safeParse({ ...capsule, last_error: lastError({ kind: "oops" }) }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({ ...capsule, last_error: lastError({ log_sha256: "xyz" }) }).success,
    ).toBe(false);
  });

  test("last_error excerpt is bounded in UTF-8 bytes", () => {
    const capsule = validCapsule();
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        last_error: lastError({ excerpt: "a".repeat(4096) }),
      }).success,
    ).toBe(true);
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        last_error: lastError({ excerpt: "a".repeat(4097) }),
      }).success,
    ).toBe(false);
    // "é" encodes as two UTF-8 bytes, so 2049 chars is 4098 bytes: over the cap
    // even though the character count is under it.
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        last_error: lastError({ excerpt: "é".repeat(2049) }),
      }).success,
    ).toBe(false);
  });

  const EXTRA_KEY = "privileges";

  function injectExtraKey(capsule: Capsule, keyPath: string): Record<string, unknown> {
    const root = structuredClone(capsule) as Record<string, unknown>;
    let target: Record<string, unknown> = root;
    for (const segment of keyPath.split(".")) {
      if (/^\d+$/.test(segment)) {
        const indexed = (target as unknown as unknown[])[Number(segment)];
        target = indexed as Record<string, unknown>;
      } else {
        target = target[segment] as Record<string, unknown>;
      }
    }
    target[EXTRA_KEY] = ["take over"];
    return root;
  }

  // Each entry is one nested schema position. A privilege-like extra key at
  // that position must be rejected, not silently stripped, so a z.strictObject
  // -> z.object mutation on any of these schemas fails a test here.
  const NESTED_EXTRA_KEY_POSITIONS: { label: string; keyPath: string }[] = [
    { label: "AdvisoryItem (advisory.memory)", keyPath: "advisory.memory.0" },
    { label: "AdvisoryItem (advisory.repo_map)", keyPath: "advisory.repo_map" },
    { label: "AdvisoryItem (advisory.log_excerpts)", keyPath: "advisory.log_excerpts.0" },
    { label: "AdvisoryLane (advisory)", keyPath: "advisory" },
    {
      label: "Provenance (advisory.memory provenance)",
      keyPath: "advisory.memory.0.provenance",
    },
    {
      label: "Provenance (advisory.repo_map provenance)",
      keyPath: "advisory.repo_map.provenance",
    },
    {
      label: "Provenance (advisory.log_excerpts provenance)",
      keyPath: "advisory.log_excerpts.0.provenance",
    },
    {
      label: "EssentialConstraint",
      keyPath: "authoritative.essential_constraints.0",
    },
    { label: "CheckRecipe", keyPath: "authoritative.check_recipes.0" },
    { label: "Tool", keyPath: "authoritative.tools.0" },
    { label: "ArtifactHandle", keyPath: "authoritative.artifact_handles.0" },
    { label: "LastError", keyPath: "last_error" },
    { label: "TokenReport", keyPath: "token_report" },
  ];

  test.each(NESTED_EXTRA_KEY_POSITIONS)(
    "$label rejects an injected extra key through CapsuleSchema",
    ({ keyPath }) => {
      const capsule = validCapsule();
      const base: Capsule = keyPath.startsWith("advisory.repo_map")
        ? { ...capsule, advisory: { ...capsule.advisory, repo_map: advisoryItem("rm1") } }
        : keyPath === "last_error"
          ? { ...capsule, last_error: lastError() as LastError }
          : capsule;
      expect(CapsuleSchema.safeParse(base).success).toBe(true);
      expect(CapsuleSchema.safeParse(injectExtraKey(base, keyPath)).success).toBe(false);
    },
  );

  test("min(1) guards reject empty strings", () => {
    const capsule = validCapsule();
    expect(CapsuleSchema.safeParse(capsule).success).toBe(true);

    const auth = (field: string): Record<string, unknown> => ({
      ...capsule,
      authoritative: { ...capsule.authoritative, [field]: "" },
    });
    expect(CapsuleSchema.safeParse(auth("objective")).success).toBe(false);
    expect(CapsuleSchema.safeParse(auth("acceptance_state")).success).toBe(false);

    const emptyProvenanceField = (field: "source" | "ref"): Record<string, unknown> => ({
      ...capsule,
      advisory: {
        ...capsule.advisory,
        memory: [
          {
            ...capsule.advisory.memory[0],
            provenance: { ...capsule.advisory.memory[0]?.provenance, [field]: "" },
          },
          ...capsule.advisory.memory.slice(1),
        ],
      },
    });
    expect(CapsuleSchema.safeParse(emptyProvenanceField("source")).success).toBe(false);
    expect(CapsuleSchema.safeParse(emptyProvenanceField("ref")).success).toBe(false);

    const advisoryItemWith = (field: "id", value: string): Record<string, unknown> => ({
      ...capsule,
      advisory: {
        ...capsule.advisory,
        memory: [
          { ...capsule.advisory.memory[0], [field]: value },
          ...capsule.advisory.memory.slice(1),
        ],
      },
    });
    expect(CapsuleSchema.safeParse(advisoryItemWith("id", "")).success).toBe(false);

    const constraintWith = (field: "id" | "text", value: string): Record<string, unknown> => ({
      ...capsule,
      authoritative: {
        ...capsule.authoritative,
        essential_constraints: [
          { ...capsule.authoritative.essential_constraints[0], [field]: value },
        ],
      },
    });
    expect(CapsuleSchema.safeParse(constraintWith("id", "")).success).toBe(false);
    expect(CapsuleSchema.safeParse(constraintWith("text", "")).success).toBe(false);

    const recipeWith = (field: "id" | "command", value: string): Record<string, unknown> => ({
      ...capsule,
      authoritative: {
        ...capsule.authoritative,
        check_recipes: [{ ...capsule.authoritative.check_recipes[0], [field]: value }],
      },
    });
    expect(CapsuleSchema.safeParse(recipeWith("id", "")).success).toBe(false);
    expect(CapsuleSchema.safeParse(recipeWith("command", "")).success).toBe(false);

    const toolWith = (
      field: "id" | "kind" | "command",
      value: string,
    ): Record<string, unknown> => ({
      ...capsule,
      authoritative: {
        ...capsule.authoritative,
        tools: [{ ...capsule.authoritative.tools[0], [field]: value }],
      },
    });
    expect(CapsuleSchema.safeParse(toolWith("id", "")).success).toBe(false);
    expect(CapsuleSchema.safeParse(toolWith("kind", "")).success).toBe(false);
    expect(CapsuleSchema.safeParse(toolWith("command", "")).success).toBe(false);

    const artifactWith = (
      field: "id" | "kind" | "uri",
      value: string,
    ): Record<string, unknown> => ({
      ...capsule,
      authoritative: {
        ...capsule.authoritative,
        artifact_handles: [{ ...capsule.authoritative.artifact_handles[0], [field]: value }],
      },
    });
    expect(CapsuleSchema.safeParse(artifactWith("id", "")).success).toBe(false);
    expect(CapsuleSchema.safeParse(artifactWith("kind", "")).success).toBe(false);
    expect(CapsuleSchema.safeParse(artifactWith("uri", "")).success).toBe(false);

    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        last_error: lastError({ excerpt: "" }),
      }).success,
    ).toBe(true);
  });

  test("token_report", () => {
    const capsule = validCapsule();
    expect(CapsuleSchema.safeParse(capsule).success).toBe(true);
    const report = capsule.token_report;
    expect(
      CapsuleSchema.safeParse({
        ...capsule,
        token_report: { ...report, estimator: "guess" },
      }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({ ...capsule, token_report: { ...report, used: -1 } }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({ ...capsule, token_report: { ...report, used: 1.5 } }).success,
    ).toBe(false);
    expect(
      CapsuleSchema.safeParse({ ...capsule, token_report: { ...report, limit: 0 } }).success,
    ).toBe(false);
  });
});

describe("refusal", () => {
  test("refusal codes are an exact closed set", () => {
    expect([...RefusalCodeSchema.options]).toEqual([
      "stale_base",
      "missing_dependency",
      "essential_overflow",
      "invalid_budget",
      "ref_out_of_scope",
      "ref_unresolved",
      "fence_violation",
      "unauthorized_handle",
      "advisory_privilege_attempt",
    ]);
    expect(RefusalCodeSchema.safeParse("unknown_code").success).toBe(false);
  });

  test("refusal() is a typed value, never thrown", () => {
    expect(() => refusal("stale_base", "x")).not.toThrow();
    const value = refusal("stale_base", "x");
    expect(value).toEqual({ ok: false, code: "stale_base", detail: "x" });
    expect(CapsuleRefusalSchema.safeParse(value).success).toBe(true);
    expect(
      CapsuleRefusalSchema.safeParse({ ok: true, code: "stale_base", detail: "x" }).success,
    ).toBe(false);
    expect(
      CapsuleRefusalSchema.safeParse({ ok: false, code: "unknown_code", detail: "x" }).success,
    ).toBe(false);
    expect(
      CapsuleRefusalSchema.safeParse({ ok: false, code: "stale_base", detail: "x", extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe("capsule hashes", () => {
  test("hashes are 64-hex", () => {
    const hashes = capsuleHashes(validCapsule());
    for (const hash of [hashes.recipe_hash, hashes.input_hash, hashes.output_hash]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("hashes ignore object key order", () => {
    const capsule = validCapsule();
    const reversed = reverseKeys(capsule);
    expect(CapsuleSchema.safeParse(reversed).success).toBe(true);
    const reversedCapsule = reversed as Capsule;
    expect(Object.keys(reversed as Record<string, unknown>)[0]).toBe("token_report");
    const expected = capsuleHashes(capsule);
    const actual = capsuleHashes(reversedCapsule);
    expect(actual.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(actual.recipe_hash).toBe(expected.recipe_hash);
    expect(actual.input_hash).toBe(expected.input_hash);
    expect(actual.output_hash).toBe(expected.output_hash);
  });

  test("content edits move the matching hashes", () => {
    const capsule = validCapsule();
    const baseline = capsuleHashes(capsule);

    const retitled: Capsule = {
      ...capsule,
      authoritative: {
        ...capsule.authoritative,
        objective: `${capsule.authoritative.objective}!`,
      },
    };
    const retitledHashes = capsuleHashes(retitled);
    expect(retitledHashes.input_hash).not.toBe(baseline.input_hash);
    expect(retitledHashes.output_hash).not.toBe(baseline.output_hash);

    const recipe = capsule.authoritative.check_recipes[0]!;
    const rerun: Capsule = {
      ...capsule,
      authoritative: {
        ...capsule.authoritative,
        check_recipes: [{ ...recipe, command: `${recipe.command} --verbose` }],
      },
    };
    expect(capsuleHashes(rerun).recipe_hash).not.toBe(baseline.recipe_hash);
  });

  test("advisory order is canonical: items sorted by their unique id", () => {
    // Advisory items are ordered by their unique id before hashing, so the
    // digests never depend on the order the items were collected in.
    const capsule = validCapsule();
    const first: Capsule = {
      ...capsule,
      advisory: {
        ...capsule.advisory,
        log_excerpts: [advisoryItem("l1"), advisoryItem("l2")],
      },
    };
    const second: Capsule = {
      ...first,
      advisory: {
        ...first.advisory,
        memory: [...first.advisory.memory].reverse(),
        log_excerpts: [...first.advisory.log_excerpts].reverse(),
      },
    };
    const a = capsuleHashes(first);
    const b = capsuleHashes(second);
    expect(a.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.input_hash).toBe(a.input_hash);
    expect(b.output_hash).toBe(a.output_hash);
  });

  test("token_report moves output_hash but not input_hash", () => {
    const capsule = validCapsule();
    const baseline = capsuleHashes(capsule);
    const bumped: Capsule = {
      ...capsule,
      token_report: { ...capsule.token_report, used: capsule.token_report.used + 1 },
    };
    const hashes = capsuleHashes(bumped);
    expect(hashes.output_hash).not.toBe(baseline.output_hash);
    expect(hashes.input_hash).toBe(baseline.input_hash);
  });

  test("recipe_hash covers schema_version, check_recipes and tools", () => {
    const capsule = validCapsule();
    expect(capsuleHashes(capsule).recipe_hash).toBe(
      digestOf({
        schema_version: 1,
        check_recipes: capsule.authoritative.check_recipes,
        tools: capsule.authoritative.tools,
      }),
    );
  });

  test("absent optionals hash without throwing", () => {
    const capsule = validCapsule();
    expect(() => capsuleHashes(capsule)).not.toThrow();
    const baseline = capsuleHashes(capsule);
    expect(baseline.input_hash).toMatch(/^[0-9a-f]{64}$/);

    const withError: Capsule = {
      ...capsule,
      last_error: {
        kind: "test",
        excerpt: "boom",
        truncated: false,
        log_sha256: "b".repeat(64),
      },
    };
    expect(capsuleHashes(withError).input_hash).not.toBe(baseline.input_hash);

    const withRepoMap: Capsule = {
      ...capsule,
      advisory: { ...capsule.advisory, repo_map: advisoryItem("rm1") },
    };
    expect(capsuleHashes(withRepoMap).input_hash).not.toBe(baseline.input_hash);
  });
});
