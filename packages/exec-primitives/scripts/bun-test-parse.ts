#!/usr/bin/env bun
/**
 * bun-test-parse.ts — the one env builder and the one output parser for every
 * `bun test` the qualification scripts spawn or read back.
 *
 * Trap (measured on bun 1.3.14): with CLAUDECODE, AGENT or REPL_ID set, `bun
 * test` prints no "(pass) <title>" lines; the summary, the exit code and the
 * "(fail)" lines are unchanged. Every title-derived gate (suite tags, section-2
 * titles, parity coverage, tag passes) would then count nothing, or count only
 * the failures. Two guards:
 *   - agentFreeEnv() is the env for every spawned bun test: the parent env
 *     with the agent-mode keys removed, plus only the caller's extras;
 *   - parseBunTest() fails closed: `problem` is set whenever the summary
 *     reports tests that the result lines do not account for.
 *
 * Usage: bun scripts/bun-test-parse.ts --self-test
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const AGENT_MODE_ENV_KEYS: readonly string[] = ["CLAUDECODE", "AGENT", "REPL_ID"];

/** The parent env minus the agent-mode keys, plus `extra`. */
export function agentFreeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !AGENT_MODE_ENV_KEYS.includes(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

export interface BunTestSummary {
  pass: number | null;
  fail: number | null;
  ran: number | null;
}

export interface BunTestParse {
  /** Distinct executed titles ("describe > test"), sorted. */
  titles: string[];
  passTitles: string[];
  failTitles: string[];
  /** Raw "(pass)" line count — compared against the summary's pass count. */
  passLines: number;
  summary: BunTestSummary;
  /** Set when the result lines cannot account for the summary. */
  problem: string | undefined;
}

const RESULT_LINE_RE = /^\((pass|fail)\) (.+?)(?: \[[\d.]+m?s\])?$/;

function summaryCount(output: string, re: RegExp): number | null {
  const m = re.exec(output)?.[1];
  return m === undefined ? null : Number(m);
}

export function bunTestSummary(output: string): BunTestSummary {
  return {
    pass: summaryCount(output, /^\s*(\d+) pass$/m),
    fail: summaryCount(output, /^\s*(\d+) fail$/m),
    ran: summaryCount(output, /^\s*Ran (\d+) tests?\b/m),
  };
}

function titleProblem(
  source: string,
  summary: BunTestSummary,
  passLines: number,
  titleCount: number,
): string | undefined {
  const keys = AGENT_MODE_ENV_KEYS.join("/");
  if ((summary.ran ?? 0) > 0 && titleCount === 0) {
    return `${source}: bun reported Ran ${String(summary.ran)} tests but 0 (pass)/(fail) titles were parsed; agent-mode output (${keys} set) hides them, refusing to count`;
  }
  if (summary.pass !== null && passLines < summary.pass) {
    return `${source}: bun summary reports ${String(summary.pass)} pass but only ${String(passLines)} (pass) lines were parsed; refusing a partial title count (${keys} set?)`;
  }
  return undefined;
}

export function parseBunTest(output: string, source: string): BunTestParse {
  const pass = new Set<string>();
  const fail = new Set<string>();
  let passLines = 0;
  for (const line of output.split("\n")) {
    const m = RESULT_LINE_RE.exec(line.trimEnd());
    const title = m?.[2];
    if (title === undefined || title === "") continue;
    if (m?.[1] === "pass") {
      passLines += 1;
      pass.add(title);
    } else {
      fail.add(title);
    }
  }
  const summary = bunTestSummary(output);
  const titles = [...new Set([...pass, ...fail])].sort();
  return {
    titles,
    passTitles: [...pass].sort(),
    failTitles: [...fail].sort(),
    passLines,
    summary,
    problem: titleProblem(source, summary, passLines, titles.length),
  };
}

// ---------------------------------------------------------------------------
// --self-test
// ---------------------------------------------------------------------------

const REPO_ROOT = dirname(dirname(dirname(import.meta.dir)));

const PROBE_SRC = `import { expect, test } from "bun:test";
test("probe one", () => { expect(1).toBe(1); });
test("probe two", () => { expect(2).toBe(2); });
`;

function parserCases(check: (ok: boolean, label: string) => void): void {
  const agent = parseBunTest("\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [5.00ms]\n", "a");
  check(agent.problem !== undefined, "summary Ran 3 with no result lines sets problem");
  const allFail = parseBunTest("\n 0 pass\n 2 fail\nRan 2 tests across 1 file.\n", "a2");
  check(allFail.problem !== undefined, "summary Ran 2 (0 pass) with no result lines sets problem");
  const partial = parseBunTest(
    "(fail) d > f1 [0.10ms]\n\n 2 pass\n 1 fail\nRan 3 tests across 1 file.\n",
    "b",
  );
  check(partial.problem !== undefined, "fail lines only, 2 pass hidden, sets problem");
  const full = parseBunTest(
    "(pass) d > p1 [0.10ms]\n(pass) d > p2\n(fail) d > f1 [0.20ms]\n\n 2 pass\n 1 fail\nRan 3 tests across 1 file.\n",
    "c",
  );
  check(
    full.problem === undefined && full.titles.join("|") === "d > f1|d > p1|d > p2",
    "complete output parses three titles with no problem",
  );
  const single = parseBunTest(
    "(pass) only [1ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file.\n",
    "d",
  );
  check(single.problem === undefined && single.summary.ran === 1, "singular 'Ran 1 test' parses");
}

function envCase(check: (ok: boolean, label: string) => void): void {
  for (const key of AGENT_MODE_ENV_KEYS) process.env[key] = "1";
  const env = agentFreeEnv({ QUALIFY_EXTRA: "x" });
  check(
    AGENT_MODE_ENV_KEYS.every((k) => !(k in env)) &&
      env["QUALIFY_EXTRA"] === "x" &&
      env["PATH"] === process.env["PATH"],
    "agentFreeEnv drops CLAUDECODE/AGENT/REPL_ID, keeps PATH, adds extras",
  );
}

function liveCases(check: (ok: boolean, label: string) => void): void {
  const dir = join(REPO_ROOT, "tmp", `bun-test-parse-selftest-${String(process.pid)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "probe.test.ts"), PROBE_SRC);
    const spawnProbe = (env: Record<string, string> | undefined): BunTestParse => {
      const r = spawnSync("bun", ["test", "./probe.test.ts"], {
        cwd: dir,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      return parseBunTest(`${r.stdout}${r.stderr}`, "live probe");
    };
    // The agent keys are set on process.env by envCase(): the inherited env
    // reproduces agent mode, agentFreeEnv() must not.
    const clean = spawnProbe(agentFreeEnv());
    check(
      clean.problem === undefined && clean.passTitles.length === 2 && clean.summary.pass === 2,
      "live bun test under agentFreeEnv() yields both (pass) titles",
    );
    const inherited = spawnProbe(undefined);
    check(
      inherited.problem !== undefined || inherited.passLines === inherited.summary.pass,
      "live bun test under the agent env is refused or fully counted, never undercounted",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selfTest(): number {
  const failures: string[] = [];
  let cases = 0;
  const check = (ok: boolean, label: string): void => {
    cases += 1;
    if (!ok) failures.push(label);
  };
  parserCases(check);
  envCase(check);
  liveCases(check);
  for (const f of failures) process.stdout.write(`bun-test-parse self-test FAIL: ${f}\n`);
  process.stdout.write(
    `bun-test-parse self-test: ${failures.length === 0 ? "PASS" : "FAIL"} (${String(cases - failures.length)}/${String(cases)} cases)\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main && process.argv.includes("--self-test")) {
  process.exit(selfTest());
}
