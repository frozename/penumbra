import { describe, expect, test } from "bun:test";

import type { GateResult } from "./gate-baseline.js";

import {
  buildGateSpecs,
  computeDelta,
  deltaExitCode,
  formatCommand,
  formatDeltaTable,
  isApplicableTestFile,
  parseBaselineJson,
  parseCliArgs,
  parseTestCounts,
  SHARD_IGNORE_PATTERNS,
} from "./gate-baseline.js";

const PASSING_SHARD_OUTPUT = [
  "bun test v1.3.14",
  "",
  "scripts/check-alias-coverage.test.ts:",
  "(pass) check-alias-coverage > buckets seat names [1.00ms]",
  "",
  " 259 pass",
  " 1 skip",
  " 0 fail",
  " 812 expect() calls",
  "Ran 260 tests across 34 files. [24.30s]",
].join("\n");

const FAILING_SHARD_OUTPUT = [
  "bun test v1.3.14",
  "",
  "scripts/thing.test.ts:",
  "(fail) thing > does the thing [2.00ms]",
  "",
  " 258 pass",
  " 0 skip",
  " 1 fail",
  "Ran 259 tests across 34 files. [24.30s]",
].join("\n");

const CRASHED_SHARD_OUTPUT = [
  "bun test v1.3.14",
  "",
  "error: Cannot find module './missing.js'",
].join("\n");

// A shard killed mid-run: counts printed, the "Ran N tests" summary never
// reached. Reporting the partial 100 as the shard's pass count would put a
// truncated number into the baseline.
const TRUNCATED_SHARD_OUTPUT = [
  "bun test v1.3.14",
  "",
  "packages/core/src/a.test.ts:",
  "(pass) a > works [1.00ms]",
  " 100 pass",
  " 0 fail",
].join("\n");

function gate(overrides: Partial<GateResult> & { name: string }): GateResult {
  return {
    command: "bun run typecheck",
    exit_code: 0,
    ok: true,
    ci_gated: true,
    pass: null,
    fail: null,
    skip: null,
    ...overrides,
  };
}

describe("parseTestCounts", () => {
  test("reads pass, fail and skip from a shard that reached its summary", () => {
    expect(parseTestCounts(PASSING_SHARD_OUTPUT)).toEqual({ pass: 259, fail: 0, skip: 1 });
  });

  test("reads the failing counts rather than assuming zero", () => {
    expect(parseTestCounts(FAILING_SHARD_OUTPUT)).toEqual({ pass: 258, fail: 1, skip: 0 });
  });

  test("returns nulls, never zeros, when the shard crashed before its summary", () => {
    expect(parseTestCounts(CRASHED_SHARD_OUTPUT)).toEqual({ pass: null, fail: null, skip: null });
  });

  test("returns nulls for a truncated run rather than a partial pass count", () => {
    expect(parseTestCounts(TRUNCATED_SHARD_OUTPUT)).toEqual({ pass: null, fail: null, skip: null });
  });

  test("strips ANSI colouring around the counts", () => {
    const coloured = PASSING_SHARD_OUTPUT.replace(
      " 259 pass",
      `${String.fromCharCode(0x1b)}[32m 259 pass${String.fromCharCode(0x1b)}[0m`,
    );
    expect(parseTestCounts(coloured).pass).toBe(259);
  });
});

describe("isApplicableTestFile", () => {
  test.each([
    ["packages/core/src/routing/router.test.ts", true],
    ["packages/core/test/tasks/writer.test.ts", true],
    ["scripts/check-alias-coverage.test.ts", true],
    ["packages/core/src/routing/router.ts", false],
    ["packages/core/dist/test/router.test.ts", false],
    ["packages/core/node_modules/x/y.test.ts", false],
    ["packages/console/e2e/mission.test.ts", false],
    ["packages/console/visual/rail.test.ts", false],
    ["packages/core/scripts/bench-router.test.ts", false],
  ])("%s -> %s", (path, expected) => {
    expect(isApplicableTestFile(path)).toBe(expected);
  });
});

describe("buildGateSpecs", () => {
  test("unscoped mirrors the CI gate order and marks format:check NOT-CI-GATED", () => {
    const specs = buildGateSpecs(["packages/core", "packages/daemon"], { scoped: false });

    expect(specs.map((spec) => spec.name)).toEqual([
      "typecheck",
      "typecheck-coverage-ratchet",
      "packages/core",
      "packages/daemon",
      "root (test/ + scripts/)",
      "lint:strict",
      "format:check",
    ]);
    expect(specs.find((spec) => spec.name === "format:check")?.ciGated).toBe(false);
    expect(specs.filter((spec) => spec.ciGated).length).toBe(6);
  });

  test("every test shard goes through bun-test-gate with all four ignore patterns", () => {
    const specs = buildGateSpecs(["packages/core"], { scoped: false });

    for (const spec of specs.filter((candidate) => candidate.parsesCounts)) {
      expect(spec.argv.slice(0, 2)).toEqual(["bun", "scripts/bun-test-gate.ts"]);
      expect(spec.argv.slice(-SHARD_IGNORE_PATTERNS.length)).toEqual([...SHARD_IGNORE_PATTERNS]);
    }
    // Never root `bun test`: it is not the gate and it crashes Bun.
    expect(specs.some((spec) => spec.argv.join(" ") === "bun test")).toBe(false);
  });

  test("the root shard excludes packages/** so it covers only test/ and scripts/", () => {
    const specs = buildGateSpecs([], { scoped: false });
    const root = specs.find((spec) => spec.name === "root (test/ + scripts/)");

    expect(root?.argv).toContain("--path-ignore-patterns=packages/**");
  });

  test("scoped builds only the named package shards", () => {
    const specs = buildGateSpecs(["packages/core"], { scoped: true });

    expect(specs.map((spec) => spec.name)).toEqual(["packages/core"]);
  });
});

describe("formatCommand", () => {
  test("quotes glob arguments so the recorded command is copy-pasteable", () => {
    expect(
      formatCommand(["bun", "scripts/bun-test-gate.ts", "--path-ignore-patterns=**/dist/**"]),
    ).toBe("bun scripts/bun-test-gate.ts '--path-ignore-patterns=**/dist/**'");
  });

  test("leaves plain arguments unquoted", () => {
    expect(formatCommand(["bun", "run", "lint:strict"])).toBe("bun run lint:strict");
  });
});

describe("parseCliArgs", () => {
  test("parses the three value flags", () => {
    expect(
      parseCliArgs(["--compare", "b.json", "--only", "core, daemon", "--timestamp", "T"]),
    ).toEqual({
      comparePath: "b.json",
      only: ["core", "daemon"],
      timestamp: "T",
      help: false,
    });
  });

  test("defaults to a full unscoped capture", () => {
    expect(parseCliArgs([])).toEqual({
      comparePath: null,
      only: null,
      timestamp: null,
      help: false,
    });
  });

  test("rejects an unknown flag instead of ignoring it", () => {
    expect(() => parseCliArgs(["--onlyy", "core"])).toThrow(/unknown argument --onlyy/);
  });

  test("rejects a value flag with no value", () => {
    expect(() => parseCliArgs(["--compare"])).toThrow(/--compare requires a value/);
    expect(() => parseCliArgs(["--compare", "--only", "core"])).toThrow(
      /--compare requires a value/,
    );
  });

  test("rejects an empty --only list", () => {
    expect(() => parseCliArgs(["--only", " , "])).toThrow(/at least one package name/);
  });
});

describe("parseBaselineJson", () => {
  const valid = {
    base_commit: "abc1234",
    captured_at: "2026-09-07T12:00:00.000Z",
    worktree_dirty: false,
    scoped_to: null,
    gates: [
      {
        name: "packages/core",
        command: "bun scripts/bun-test-gate.ts packages/core",
        exit_code: 0,
        ok: true,
        ci_gated: true,
        pass: 259,
        fail: 0,
        skip: 1,
      },
    ],
  };

  test("round-trips a captured baseline", () => {
    expect(parseBaselineJson(JSON.stringify(valid))).toEqual(valid);
  });

  test("rejects malformed JSON", () => {
    expect(() => parseBaselineJson("{not json}")).toThrow(/not valid JSON/);
  });

  test("rejects a baseline whose gates are not an array", () => {
    expect(() => parseBaselineJson(JSON.stringify({ ...valid, gates: {} }))).toThrow(
      /baseline.gates must be an array/,
    );
  });

  test("rejects a gate missing its exit code rather than defaulting it to zero", () => {
    const broken = { ...valid, gates: [{ ...valid.gates[0], exit_code: undefined }] };
    expect(() => parseBaselineJson(JSON.stringify(broken))).toThrow(
      /baseline.gates\[0\].exit_code must be a number/,
    );
  });
});

describe("computeDelta", () => {
  test("a green gate going red is a regression", () => {
    const rows = computeDelta(
      [gate({ name: "lint:strict" })],
      [gate({ name: "lint:strict", exit_code: 1, ok: false })],
      { scoped: false },
    );

    expect(rows[0]?.status).toBe("regression");
    expect(deltaExitCode(rows)).toBe(1);
  });

  test("a dropped pass count is a regression even while the gate stays green", () => {
    const rows = computeDelta(
      [gate({ name: "packages/core", pass: 259, fail: 0 })],
      [gate({ name: "packages/core", pass: 258, fail: 0 })],
      { scoped: false },
    );

    expect(rows[0]?.status).toBe("regression");
    expect(rows[0]?.note).toBe("pass count dropped 259 -> 258");
    expect(deltaExitCode(rows)).toBe(1);
  });

  test("a rising fail count is a regression even while the gate stays red", () => {
    const rows = computeDelta(
      [gate({ name: "packages/daemon", exit_code: 1, ok: false, pass: 100, fail: 2 })],
      [gate({ name: "packages/daemon", exit_code: 1, ok: false, pass: 100, fail: 3 })],
      { scoped: false },
    );

    expect(rows[0]?.status).toBe("regression");
    expect(rows[0]?.note).toBe("fail count rose 2 -> 3");
    expect(deltaExitCode(rows)).toBe(1);
  });

  test("a rising fail count beats a rising pass count: regression, not improved", () => {
    const rows = computeDelta(
      [gate({ name: "packages/daemon", exit_code: 1, ok: false, pass: 100, fail: 2 })],
      [gate({ name: "packages/daemon", exit_code: 1, ok: false, pass: 101, fail: 5 })],
      { scoped: false },
    );

    expect(rows[0]?.status).toBe("regression");
    expect(rows[0]?.note).toBe("fail count rose 2 -> 5");
    expect(deltaExitCode(rows)).toBe(1);
  });

  test("a dropping fail count is improved", () => {
    const rows = computeDelta(
      [gate({ name: "packages/daemon", exit_code: 1, ok: false, pass: 100, fail: 5 })],
      [gate({ name: "packages/daemon", exit_code: 1, ok: false, pass: 100, fail: 2 })],
      { scoped: false },
    );

    expect(rows[0]?.status).toBe("improved");
    expect(rows[0]?.note).toBe("fail count dropped 5 -> 2");
    expect(deltaExitCode(rows)).toBe(0);
  });

  test("a dropping fail count does not mask a dropping pass count", () => {
    const rows = computeDelta(
      [gate({ name: "packages/daemon", exit_code: 1, ok: false, pass: 100, fail: 5 })],
      [gate({ name: "packages/daemon", exit_code: 1, ok: false, pass: 50, fail: 2 })],
      { scoped: false },
    );

    expect(rows[0]?.status).toBe("regression");
    expect(deltaExitCode(rows)).toBe(1);
  });

  test("a null fail count on either side falls back to the pass-based classification", () => {
    const rows = computeDelta(
      [
        gate({ name: "packages/a", pass: 100, fail: null }),
        gate({ name: "packages/b", pass: 100, fail: 5 }),
        gate({ name: "packages/c", pass: 100, fail: null }),
      ],
      [
        gate({ name: "packages/a", pass: 101, fail: 5 }),
        gate({ name: "packages/b", pass: 101, fail: null }),
        gate({ name: "packages/c", pass: 101, fail: null }),
      ],
      { scoped: false },
    );

    expect(rows.map((row) => row.status)).toEqual(["improved", "improved", "improved"]);
    expect(deltaExitCode(rows)).toBe(0);
  });

  test("a red gate that stays red at the same counts is not a regression", () => {
    const red = gate({ name: "format:check", exit_code: 1, ok: false, ci_gated: false });
    const rows = computeDelta([red], [red], { scoped: false });

    expect(rows[0]?.status).toBe("same");
    expect(deltaExitCode(rows)).toBe(0);
  });

  test("a red gate going green is fixed, and a rising pass count is improved", () => {
    const rows = computeDelta(
      [
        gate({ name: "lint:strict", exit_code: 1, ok: false }),
        gate({ name: "packages/core", pass: 10 }),
      ],
      [gate({ name: "lint:strict" }), gate({ name: "packages/core", pass: 12 })],
      { scoped: false },
    );

    expect(rows.map((row) => row.status)).toEqual(["fixed", "improved"]);
    expect(deltaExitCode(rows)).toBe(0);
  });

  test("a gate the baseline had and this run did not is a regression when unscoped", () => {
    const rows = computeDelta([gate({ name: "typecheck" })], [], { scoped: false });

    expect(rows[0]?.status).toBe("regression");
    expect(rows[0]?.note).toBe("gate in the baseline was not run");
    expect(deltaExitCode(rows)).toBe(1);
  });

  test("the same absent gate is only MISSING when --only scoped it out", () => {
    const rows = computeDelta([gate({ name: "typecheck" })], [], { scoped: true });

    expect(rows[0]?.status).toBe("missing");
    expect(deltaExitCode(rows)).toBe(0);
  });

  test("a gate absent from the baseline is NEW, not a regression", () => {
    const rows = computeDelta([], [gate({ name: "packages/newpkg", exit_code: 1, ok: false })], {
      scoped: false,
    });

    expect(rows[0]?.status).toBe("new");
    expect(deltaExitCode(rows)).toBe(0);
  });

  test("rows keep baseline order and append new gates at the end", () => {
    const rows = computeDelta(
      [gate({ name: "typecheck" }), gate({ name: "lint:strict" })],
      [gate({ name: "lint:strict" }), gate({ name: "packages/new" }), gate({ name: "typecheck" })],
      { scoped: false },
    );

    expect(rows.map((row) => row.name)).toEqual(["typecheck", "lint:strict", "packages/new"]);
  });
});

describe("formatDeltaTable", () => {
  test("renders counts per gate and flags the non-CI-gated row", () => {
    const rows = computeDelta(
      [gate({ name: "packages/core", pass: 259, fail: 0 })],
      [gate({ name: "packages/core", pass: 259, fail: 0 })],
      { scoped: false },
    );
    rows.push(
      ...computeDelta(
        [gate({ name: "format:check", exit_code: 1, ok: false, ci_gated: false })],
        [gate({ name: "format:check", exit_code: 1, ok: false, ci_gated: false })],
        { scoped: false },
      ),
    );

    const table = formatDeltaTable(rows);

    expect(table.split("\n")[0]).toContain("gate");
    expect(table).toContain("exit 0 259p/0f");
    expect(table).toContain("SAME");
    expect(table).toContain("[NOT-CI-GATED]");
  });
});
