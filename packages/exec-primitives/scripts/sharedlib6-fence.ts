#!/usr/bin/env bun
/**
 * sharedlib6-fence.ts — the contract fence (dispatch section 0) as one pure
 * rule over `git diff --name-only --no-renames <base> HEAD` plus the two allowed root
 * edits, read at base and at HEAD:
 *   - every changed path lies under packages/exec-primitives/ or
 *     docs/qualification/, or is bun.lock, tsconfig.json or
 *     typecheck-coverage-ratchet.json;
 *   - tsconfig.json differs from base by exactly one added reference,
 *     { "path": "./packages/exec-primitives" };
 *   - typecheck-coverage-ratchet.json differs from base by exactly one added
 *     packages entry, "packages/exec-primitives".
 * sharedlib6-check.ts runs this as step 13 and --self-test as a precheck.
 *
 * Usage: bun scripts/sharedlib6-fence.ts --self-test
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { deepEqual, rec } from "./sharedlib6-shape-util.js";

export const FENCE_PATH_RE =
  /^(?:packages\/exec-primitives\/|docs\/qualification\/|bun\.lock$|tsconfig\.json$|typecheck-coverage-ratchet\.json$)/;
export const FENCE_REFERENCE = "./packages/exec-primitives";
export const FENCE_RATCHET_KEY = "packages/exec-primitives";

/** The git argv whose output feeds FenceInput.names. --no-renames lists both
 * sides of a move: with rename detection (git's default), a file moved out of
 * another package shows only its in-fence destination. */
export function fenceNameDiffArgs(base: string): string[] {
  return ["diff", "--name-only", "--no-renames", base, "HEAD"];
}

export interface FenceInput {
  /** `git diff --name-only --no-renames <base> HEAD`, one path per entry. */
  names: string[];
  /** File text at base and HEAD; null when the file is absent there. */
  tsconfigBase: string | null;
  tsconfigHead: string | null;
  ratchetBase: string | null;
  ratchetHead: string | null;
}

type Obj = Record<string, unknown>;

function parseObj(text: string | null): Obj | undefined {
  if (text === null) return undefined;
  try {
    return rec(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function without(o: Obj, key: string): Obj {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
}

/** HEAD tsconfig = base tsconfig plus exactly one { path: FENCE_REFERENCE }. */
function tsconfigReasons(baseText: string | null, headText: string | null): string[] {
  if (baseText === headText) return [];
  const base = parseObj(baseText);
  const head = parseObj(headText);
  if (base === undefined || head === undefined) {
    return ["tsconfig.json is unparseable or missing at base or HEAD"];
  }
  const baseRefs = Array.isArray(base["references"]) ? base["references"] : [];
  const headRefs = Array.isArray(head["references"]) ? head["references"] : [];
  const isFence = (r: unknown): boolean => rec(r)?.["path"] === FENCE_REFERENCE;
  const reasons: string[] = [];
  if (!deepEqual(without(base, "references"), without(head, "references"))) {
    reasons.push("tsconfig.json changes more than its references");
  }
  if (baseRefs.some(isFence) || headRefs.filter(isFence).length !== 1) {
    reasons.push(`tsconfig.json must add exactly one reference ${FENCE_REFERENCE}`);
  }
  if (
    !deepEqual(
      headRefs.filter((r) => !isFence(r)),
      baseRefs,
    )
  ) {
    reasons.push("tsconfig.json changes a reference other than the one allowed");
  }
  return reasons;
}

/** HEAD ratchet = base ratchet plus exactly one packages entry, 0 errors. */
function ratchetReasons(baseText: string | null, headText: string | null): string[] {
  if (baseText === headText) return [];
  const base = parseObj(baseText);
  const head = parseObj(headText);
  if (base === undefined || head === undefined) {
    return ["typecheck-coverage-ratchet.json is unparseable or missing at base or HEAD"];
  }
  const basePkgs = rec(base["packages"]) ?? {};
  const headPkgs = rec(head["packages"]) ?? {};
  const reasons: string[] = [];
  if (!deepEqual(without(base, "packages"), without(head, "packages"))) {
    reasons.push("typecheck-coverage-ratchet.json changes a key outside packages");
  }
  if (FENCE_RATCHET_KEY in basePkgs || !deepEqual(headPkgs[FENCE_RATCHET_KEY], { errorCount: 0 })) {
    reasons.push(
      `typecheck-coverage-ratchet.json must add exactly one entry ${FENCE_RATCHET_KEY} with errorCount 0`,
    );
  }
  if (!deepEqual(without(headPkgs, FENCE_RATCHET_KEY), basePkgs)) {
    reasons.push("typecheck-coverage-ratchet.json changes an entry other than the one allowed");
  }
  return reasons;
}

export function fenceReasons(input: FenceInput): string[] {
  const reasons = input.names
    .filter((n) => n !== "" && !FENCE_PATH_RE.test(n))
    .map((n) => `path outside the fence: ${n}`);
  reasons.push(...tsconfigReasons(input.tsconfigBase, input.tsconfigHead));
  reasons.push(...ratchetReasons(input.ratchetBase, input.ratchetHead));
  return reasons;
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

const TSCONFIG_BASE = JSON.stringify({
  files: [],
  compilerOptions: { experimentalDecorators: true },
  references: [{ path: "./packages/core" }, { path: "./plugin" }],
});
const TSCONFIG_HEAD = JSON.stringify({
  files: [],
  compilerOptions: { experimentalDecorators: true },
  references: [{ path: "./packages/core" }, { path: FENCE_REFERENCE }, { path: "./plugin" }],
});
const RATCHET_BASE = JSON.stringify({
  optionSet: "strict",
  packages: { "packages/core": { errorCount: 3 } },
  total: 3,
});
const RATCHET_HEAD = JSON.stringify({
  optionSet: "strict",
  packages: { "packages/core": { errorCount: 3 }, [FENCE_RATCHET_KEY]: { errorCount: 0 } },
  total: 3,
});
const IN_FENCE = [
  "bun.lock",
  "docs/qualification/2026-09-24-sharedlib6-qualification.json",
  "packages/exec-primitives/src/index.ts",
  "tsconfig.json",
  "typecheck-coverage-ratchet.json",
];

function input(over: Partial<FenceInput>): FenceInput {
  return {
    names: IN_FENCE,
    tsconfigBase: TSCONFIG_BASE,
    tsconfigHead: TSCONFIG_HEAD,
    ratchetBase: RATCHET_BASE,
    ratchetHead: RATCHET_HEAD,
    ...over,
  };
}

function edited(text: string, apply: (j: Record<string, unknown>) => void): string {
  const j = JSON.parse(text) as Record<string, unknown>;
  apply(j);
  return JSON.stringify(j);
}

const FENCE_CASES: { label: string; input: FenceInput; red: RegExp | null }[] = [
  { label: "the branch shape stays green", input: input({}), red: null },
  {
    label: "unchanged tsconfig and ratchet stay green",
    input: input({
      names: ["packages/exec-primitives/src/index.ts"],
      tsconfigHead: TSCONFIG_BASE,
      ratchetHead: RATCHET_BASE,
    }),
    red: null,
  },
  {
    label: "packages/core/X is outside the fence",
    input: input({ names: [...IN_FENCE, "packages/core/X"] }),
    red: /outside the fence: packages\/core\/X/,
  },
  {
    label: "packages/agentchat/README.md is outside the fence",
    input: input({ names: [...IN_FENCE, "packages/agentchat/README.md"] }),
    red: /outside the fence: packages\/agentchat\/README\.md/,
  },
  {
    label: "a sibling prefix is outside the fence",
    input: input({ names: ["packages/exec-primitives-evil/x.ts", "docs/notes/n.md"] }),
    red: /outside the fence: packages\/exec-primitives-evil\/x\.ts/,
  },
  {
    label: "a second tsconfig reference is refused",
    input: input({
      tsconfigHead: edited(TSCONFIG_HEAD, (j) => {
        (j["references"] as unknown[]).push({ path: "./packages/extra" });
      }),
    }),
    red: /tsconfig\.json/,
  },
  {
    label: "a tsconfig compilerOptions edit is refused",
    input: input({
      tsconfigHead: edited(TSCONFIG_HEAD, (j) => {
        j["compilerOptions"] = { experimentalDecorators: false };
      }),
    }),
    red: /tsconfig\.json/,
  },
  {
    label: "a tsconfig reference to another path is refused",
    input: input({ tsconfigHead: TSCONFIG_HEAD.replace(FENCE_REFERENCE, "./packages/other") }),
    red: /tsconfig\.json/,
  },
  {
    label: "a changed ratchet entry is refused",
    input: input({
      ratchetHead: edited(RATCHET_HEAD, (j) => {
        (j["packages"] as Record<string, unknown>)["packages/core"] = { errorCount: 9 };
      }),
    }),
    red: /typecheck-coverage-ratchet\.json/,
  },
  {
    label: "a changed ratchet total is refused",
    input: input({ ratchetHead: edited(RATCHET_HEAD, (j) => (j["total"] = 4)) }),
    red: /typecheck-coverage-ratchet\.json/,
  },
  {
    label: "a ratchet without the added entry is refused",
    input: input({ ratchetHead: RATCHET_BASE.replace('"total":3', '"total":3 ') }),
    red: /typecheck-coverage-ratchet\.json/,
  },
  {
    label: "unparseable tsconfig at HEAD is refused",
    input: input({ tsconfigHead: "{" }),
    red: /tsconfig\.json/,
  },
];

const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));

/** A scratch repo commits packages/core/big.ts, then `git mv`s it into the
 * package with diff.renames on. The names fenceNameDiffArgs() yields must
 * still carry the source path, so a file moved out of another package is
 * outside the fence. */
function renameCase(): string[] {
  const dir = join(REPO_ROOT, "tmp", `fence-selftest-${String(process.pid)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "packages", "core"), { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  ) as Record<string, string>;
  const git = (args: string[]): string => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "user.name=fence",
        "-c",
        "user.email=fence@self.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "diff.renames=true",
        ...args,
      ],
      { cwd: dir, env: { ...env, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  try {
    git(["init", "-q"]);
    const body = Array.from({ length: 40 }, (_, i) => `export const v${String(i)} = ${String(i)};`);
    writeFileSync(join(dir, "packages", "core", "big.ts"), `${body.join("\n")}\n`);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    mkdirSync(join(dir, "packages", "exec-primitives"), { recursive: true });
    git(["mv", "packages/core/big.ts", "packages/exec-primitives/big.ts"]);
    git(["commit", "-q", "-m", "move"]);
    const names = git(fenceNameDiffArgs(base))
      .split("\n")
      .map((l) => l.trim());
    const reasons = fenceReasons({
      names,
      tsconfigBase: null,
      tsconfigHead: null,
      ratchetBase: null,
      ratchetHead: null,
    });
    return reasons.some((r) => r.includes("outside the fence: packages/core/big.ts"))
      ? []
      : [`a file moved out of packages/core is not refused (names: ${JSON.stringify(names)})`];
  } catch (err) {
    return [`rename case: ${String(err)}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selfTest(): number {
  const failures: string[] = [];
  for (const c of FENCE_CASES) {
    const reasons = fenceReasons(c.input);
    const ok = c.red === null ? reasons.length === 0 : reasons.some((r) => c.red?.test(r) === true);
    if (!ok) failures.push(`${c.label} (reasons: ${JSON.stringify(reasons)})`);
  }
  failures.push(...renameCase());
  const total = FENCE_CASES.length + 1;
  for (const f of failures) process.stdout.write(`fence self-test FAIL: ${f}\n`);
  process.stdout.write(
    `fence self-test: ${failures.length === 0 ? "PASS" : "FAIL"} (${String(total - failures.length)}/${String(total)} cases)\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main && process.argv.includes("--self-test")) {
  process.exit(selfTest());
}
