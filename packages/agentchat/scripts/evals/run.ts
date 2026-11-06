import { Branding } from "@penumbra/core";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graderBuildId } from "./grader/build-id.js";
import { createDefaultDependencyProvider, type DependencyProvider } from "./grader/deps.js";
import { detectSandbox, type SandboxKind } from "./grader/sandbox.js";
import { type GraderScratch, openGraderScratch } from "./grader/scratch.js";
import { type GraderAllowlist, loadGraderAllowlist } from "./grader/verify.js";
import {
  makeSession,
  resolveSessionStore,
  type SessionState,
  StageError,
  stageFlag,
  type StageInvocation,
  type StageOutcome,
} from "./session.js";
import { parseStages, runStage } from "./stages.js";

export const BLOCKED_MESSAGE = "BLOCKED: live trials require a separately authorized stage";
export const AUTOCOMMIT_FLAG_SHA = "06cfcc9acc77cbc0d3650d50c6af1294e702d21b";

export interface RunResult {
  code: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export interface RunDeps {
  now: () => number;
  storageRoot: string;
  buildId: () => Promise<string>;
  allowlist: () => GraderAllowlist;
  deps: () => DependencyProvider;
  sandbox: () => Promise<SandboxKind>;
  timeoutMs: number;
}

const BLOCKED_FLAGS: ReadonlySet<string> = new Set(["--live", "--agent", "--executor"]);

function blockedResult(): RunResult {
  return { code: 2, stdout: "", stderr: `${BLOCKED_MESSAGE}\n` };
}

function defaultRunDeps(): RunDeps {
  return {
    now: () => Date.now(),
    storageRoot: process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot,
    buildId: () => graderBuildId(),
    allowlist: () => loadGraderAllowlist(),
    deps: () =>
      createDefaultDependencyProvider({
        cacheRoot: join(tmpdir(), "penumbra-eval-dep-cache"),
        allowInstall: false,
      }),
    sandbox: () => detectSandbox(),
    timeoutMs: 20_000,
  };
}

export async function resolveHarnessBuild(
  input: { design: "controlled" | "observational"; buildSha: string | null },
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>,
): Promise<{ sha: string | null; missing_reason?: string }> {
  if (input.design === "observational") {
    return { sha: null, missing_reason: "observational" };
  }
  if (input.buildSha === null) {
    return { sha: null, missing_reason: "build_sha_unknown" };
  }
  const ancestor = await isAncestor(AUTOCOMMIT_FLAG_SHA, input.buildSha);
  if (!ancestor) {
    return { sha: null, missing_reason: "build_predates_autocommit_flag" };
  }
  return { sha: input.buildSha };
}

function writeStageOut(outPath: string, output: string): string | null {
  try {
    writeFileSync(resolve(outPath), output);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function runStages(
  session: SessionState,
  stages: readonly StageInvocation[],
): Promise<RunResult> {
  const stageNames = stages.map((stage) => stage.name);
  let stdout = "";
  const lastIndex = stages.length - 1;
  for (const [index, stage] of stages.entries()) {
    const outcome = await runStage(session, stage, stageNames);
    const outPath = stageFlag(stage, "--out");
    if (outPath !== undefined) {
      const writeError = writeStageOut(outPath, outcome.output);
      if (writeError !== null) {
        return { code: 1, stdout, stderr: `${writeError}\n` };
      }
    } else if (index === lastIndex) {
      stdout = outcome.output;
    }
    if (outcome.code !== 0) {
      return { code: outcome.code, stdout, stderr: outcome.stderr };
    }
  }
  return { code: 0, stdout, stderr: "" };
}

export async function runCli(argv: readonly string[], deps?: Partial<RunDeps>): Promise<RunResult> {
  if (argv.some((arg) => BLOCKED_FLAGS.has(arg))) {
    return blockedResult();
  }
  const parsed = parseStages(argv);
  if (!parsed.ok) {
    return parsed.blocked
      ? blockedResult()
      : { code: 2, stdout: "", stderr: `usage: ${parsed.message}\n` };
  }
  if (parsed.stages.length === 0) {
    return { code: 2, stdout: "", stderr: "usage: no stages\n" };
  }
  const merged: RunDeps = { ...defaultRunDeps(), ...deps };
  const scratch: GraderScratch = await openGraderScratch({ sourceRepo: null });
  try {
    const session = makeSession(merged, scratch, parsed.stages);
    let storeError: StageOutcome | null;
    try {
      storeError = await resolveSessionStore(session, parsed.stages);
    } catch (err) {
      if (err instanceof StageError) {
        const message = err.message.endsWith("\n") ? err.message : `${err.message}\n`;
        return { code: err.code, stdout: "", stderr: message };
      }
      throw err;
    }
    if (storeError !== null) {
      return { code: storeError.code, stdout: "", stderr: storeError.stderr };
    }
    return await runStages(session, parsed.stages);
  } finally {
    scratch.close();
  }
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
