import { getDispatchCapsuleMode } from "@penumbra/config";
import {
  classifyGitHooks,
  type Clock,
  type DispatchEventLog,
  type Logger,
  type Services,
} from "@penumbra/core";
import {
  type AdvisoryItem,
  type BudgetLimits,
  capsuleHashes,
  compileCapsule,
  type CompileInput,
  type CompileOptions,
  type CompileResult,
  type HookProbeOutcome,
  type PathProbeOutcome,
  type PreflightRequest,
  type PreflightResult,
  type ProbeOutcome,
  type ProbePort,
  runPreflight,
} from "@penumbra/core/dispatch/capsule";
import { digestOf } from "@penumbra/core/evals/canonical";
import { execFile } from "node:child_process";
import { homedir } from "node:os";

import {
  type CapsuleGitPort,
  capsulePathExists,
  createCapsuleGitPort,
  createCapsuleProbePort,
} from "./capsule-probe.js";

export interface CapsuleProbePortRequest {
  worktreeRoot: string;
  baseSha: string;
  storageRoot: string;
  operatorCheckout: string;
}

export type CapsuleShadowMode = "off" | "shadow";

export const CAPSULE_SHADOW_EVENT_KIND = "dispatch.capsule_shadow";
export const CAPSULE_SHADOW_TIMEOUT_MS = 2_000;
export const CAPSULE_SHADOW_MAX_IN_FLIGHT = 4;
export const CAPSULE_SHADOW_BUDGET: BudgetLimits = {
  limit: 32_000,
  reserve_response: 4_000,
  reserve_tool: 2_000,
};

const PREFLIGHT_CODES_MAX = 32;
const DROPPED_IDS_MAX = 32;
const DEDUPE_KEYS_MAX = 1_024;
const EVENT_META_MAX_BYTES = 4_096;
const ERROR_EXCERPT_MAX_BYTES = 512;

export interface CapsuleShadowArgs {
  handoff_id: string;
  objective: string;
  project_root: string | undefined;
  dispatch_worktree_root?: string | undefined;
  branch_base?: string | undefined;
  advisory_memory: { source: "auto_recall" | "project_brief"; text: string }[];
  recalled_memory_ids: string[];
}

export interface CapsuleShadowDeps {
  compile?: (input: CompileInput, options: CompileOptions) => Promise<CompileResult>;
  preflight?: (port: ProbePort, req: PreflightRequest) => Promise<PreflightResult>;
  gitPort?: (root: string) => CapsuleGitPort | Promise<CapsuleGitPort>;
  probePort?: (opts: CapsuleProbePortRequest) => ProbePort | Promise<ProbePort>;
  effectiveHooksPath?: (root: string) => Promise<string | null>;
  pathExists?: (path: string) => Promise<boolean>;
  // Accepted for call-site compatibility but never read: the daemon's own
  // storage root is never the dispatch's storage and must never reach the probe.
  storageRoot?: string;
  homeDir?: string;
  timeoutMs?: number;
  log?: Logger;
  eventLog?: Pick<DispatchEventLog, "record">;
  clock?: Clock;
}

export function readCapsuleShadowMode(
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
): CapsuleShadowMode {
  try {
    return getDispatchCapsuleMode(env);
  } catch (error) {
    log.warn(
      {
        event: "capsule_shadow_error",
        err: error instanceof Error ? error.message : String(error),
      },
      "capsule shadow mode read failed; defaulting to off",
    );
    return "off";
  }
}

const TOKEN_PATTERN =
  /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abprs]-[\w-]{10,})/g;
const HOME_PATH_PATTERN = /\/(?:Users|home)\/[^/\s]+/g;

function redactErrorExcerpt(message: string): string {
  const redacted = message
    .replaceAll(TOKEN_PATTERN, "[REDACTED:token]")
    .replaceAll(HOME_PATH_PATTERN, "~");
  const encoded = new TextEncoder().encode(redacted);
  if (encoded.byteLength <= ERROR_EXCERPT_MAX_BYTES) {
    return redacted;
  }
  const truncated = new TextDecoder().decode(encoded.subarray(0, ERROR_EXCERPT_MAX_BYTES));
  return truncated.endsWith("\uFFFD") ? truncated.slice(0, -1) : truncated;
}

function describeError(error: unknown): { error_name: string; error: string } {
  return {
    error_name: error instanceof Error ? error.name : "UnknownError",
    error: redactErrorExcerpt(error instanceof Error ? error.message : String(error)),
  };
}

function logShadowThrow(
  log: Logger | undefined,
  handoffId: string,
  reason: "throw",
  error: unknown,
): void {
  log?.warn(
    {
      event: "capsule_shadow_error",
      handoff_id: handoffId,
      reason,
      ...describeError(error),
    },
    "capsule shadow run failed; dispatch unaffected",
  );
}

function defaultEffectiveHooksPath(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "config", "--get", "core.hooksPath"],
      { encoding: "utf8", timeout: 10_000 },
      (error, stdout) => {
        // git exits 1 when core.hooksPath is unset.
        resolve(error === null ? stdout.replace(/\r?\n$/, "") : null);
      },
    );
  });
}

const testState = {
  depsOverride: null as Partial<CapsuleShadowDeps> | null,
  dedupeKeys: new Set<string>(),
  inFlight: new Set<Promise<void>>(),
  inFlightCount: 0,
};

function rememberDedupeKey(key: string): void {
  if (testState.dedupeKeys.size >= DEDUPE_KEYS_MAX) {
    const oldest = testState.dedupeKeys.values().next().value;
    if (oldest !== undefined) {
      testState.dedupeKeys.delete(oldest);
    }
  }
  testState.dedupeKeys.add(key);
}

function advisoryItems(args: CapsuleShadowArgs): AdvisoryItem[] {
  const ref = args.recalled_memory_ids.join(",") || "none";
  return args.advisory_memory.map((entry, index) => ({
    id: `${entry.source}:${String(index)}`,
    authority: "advisory" as const,
    text: entry.text,
    provenance: { source: entry.source, ref },
  }));
}

function trimEventMeta(meta: Record<string, unknown>): void {
  const sizeBytes = (): number => new TextEncoder().encode(JSON.stringify(meta)).byteLength;
  if (sizeBytes() <= EVENT_META_MAX_BYTES) return;
  delete meta["token_report"];
  meta["dropped_ids"] = [];
  if (sizeBytes() <= EVENT_META_MAX_BYTES) return;
  meta["preflight_codes"] = [];
}

const WORKTREE_DEPENDENT_PROBES: ReadonlySet<string> = new Set([
  "hasCode",
  "hasTests",
  "storagePath",
  "operatorCheckout",
  "artifactReadable",
  "hookStatus",
]);

const WORKTREE_DEFERRED_CODE = "worktree_deferred";

/*
 * Shadow storage isolation: the storage under test is the dispatch's own test
 * storage, <dispatch worktree>/.test-storage, where the worker's test storage
 * lives. It is isolated iff it is neither inside the operator checkout nor
 * inside home_dir (preflight.collectStorage's rule). The daemon's own storage
 * root (services.storageRoot) is never the dispatch's storage and is never
 * probed. Before the worktree exists, the check is deferred
 * (worktree_deferred), not failed.
 */
function deferredProbePort(probe: ProbePort): ProbePort {
  const outcome = { status: "unknown", detail: "worktree deferred" } as const;
  return {
    ...probe,
    hasCode: (): Promise<ProbeOutcome> => Promise.resolve(outcome),
    hasTests: (): Promise<ProbeOutcome> => Promise.resolve(outcome),
    storagePath: (): Promise<PathProbeOutcome> => Promise.resolve(outcome),
    operatorCheckout: (): Promise<PathProbeOutcome> => Promise.resolve(outcome),
    artifactReadable: (): Promise<ProbeOutcome> => Promise.resolve(outcome),
    hookStatus: (): Promise<HookProbeOutcome> => Promise.resolve(outcome),
  };
}

// #536: reconcile the capsule-probe repo-local hooks view with the
// daemon-side effective hooks path. A disagreement is a signal only.
// Against the worktree once it exists; while deferred, only when the
// daemon's effective hooks path itself exists — reconciling against a
// dangling path would consume worktree-dependent probe calls that the
// deferral promises not to run.
async function hookViewDisagreement(
  probe: ProbePort,
  repo: string,
  worktreeRoot: string | undefined,
  worktreeReady: boolean,
  deps: CapsuleShadowDeps,
): Promise<boolean> {
  if (deps.effectiveHooksPath === undefined) {
    return false;
  }
  const root = worktreeReady && worktreeRoot !== undefined ? worktreeRoot : repo;
  const hooksPath = await deps.effectiveHooksPath(root);
  if (!worktreeReady) {
    const pathExists = deps.pathExists ?? capsulePathExists;
    if (hooksPath === null || !(await pathExists(hooksPath))) {
      return false;
    }
  }
  const hook = await probe.hookStatus();
  if (hook.status !== "ok") {
    return false;
  }
  return classifyGitHooks(root, hooksPath).status !== hook.hooks;
}

async function collectPreflightCodes(
  repo: string,
  worktreeRoot: string | undefined,
  worktreeReady: boolean,
  requestedBase: string | null,
  deps: CapsuleShadowDeps,
): Promise<string[]> {
  if (deps.probePort === undefined || deps.preflight === undefined) {
    throw new Error("capsule shadow deps incomplete");
  }
  const probe = await deps.probePort({
    worktreeRoot: worktreeReady && worktreeRoot !== undefined ? worktreeRoot : repo,
    baseSha: requestedBase ?? "",
    storageRoot: worktreeRoot === undefined ? "" : `${worktreeRoot}/.test-storage`,
    operatorCheckout: repo,
  });
  const preflightReq: PreflightRequest = {
    runtimes: [],
    tools: [],
    supported_tool_kinds: [],
    artifact_handles: [],
    home_dir: deps.homeDir ?? homedir(),
  };
  const preflightResult = await deps.preflight(
    worktreeReady ? probe : deferredProbePort(probe),
    preflightReq,
  );
  const codes = new Set<string>();
  for (const failure of preflightResult.failures) {
    if (!worktreeReady && WORKTREE_DEPENDENT_PROBES.has(failure.probe)) {
      continue;
    }
    codes.add(failure.code);
  }
  if (!worktreeReady) {
    codes.add(WORKTREE_DEFERRED_CODE);
  }
  if (await hookViewDisagreement(probe, repo, worktreeRoot, worktreeReady, deps)) {
    codes.add("hook_view_disagreement");
  }
  return [...codes].toSorted().slice(0, PREFLIGHT_CODES_MAX);
}

function buildEventMeta(
  result: CompileResult,
  compileInput: CompileInput,
  preflightCodes: string[],
  args: CapsuleShadowArgs,
  log: Logger | undefined,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    input_hash: "",
    dropped_ids: [],
    preflight_codes: preflightCodes,
  };
  if (result.ok) {
    const hashes = capsuleHashes(result.capsule);
    meta["recipe_hash"] = hashes.recipe_hash;
    meta["input_hash"] = hashes.input_hash;
    meta["output_hash"] = hashes.output_hash;
    meta["token_report"] = {
      estimator: result.capsule.token_report.estimator,
      used: result.capsule.token_report.used,
      limit: result.capsule.token_report.limit,
    };
    meta["dropped_ids"] = result.dropped.map((dropped) => dropped.id).slice(0, DROPPED_IDS_MAX);
    return meta;
  }
  meta["input_hash"] = digestOf(compileInput);
  meta["refusal_code"] = result.code;
  log?.warn(
    { event: "capsule_shadow_error", handoff_id: args.handoff_id, code: result.code },
    "capsule shadow compile refused",
  );
  return meta;
}

async function shadowWork(args: CapsuleShadowArgs, deps: CapsuleShadowDeps): Promise<void> {
  try {
    const compile = deps.compile;
    const gitPort = deps.gitPort;
    if (compile === undefined || gitPort === undefined) {
      throw new Error("capsule shadow deps incomplete");
    }
    const repo = args.project_root;
    const worktreeRoot = args.dispatch_worktree_root;
    const repoGit = repo === undefined ? null : await gitPort(repo);

    // Absent branch_base means the WorktreeManager default baseRef "HEAD";
    // resolving it goes through the object store, not the checkout's HEAD.
    let requestedBase: string | null = null;
    if (repoGit !== null) {
      if (args.branch_base === undefined) {
        requestedBase = await repoGit.head();
      } else {
        requestedBase = (await repoGit.resolveRef?.(args.branch_base)) ?? null;
      }
    }

    const worktreeReady =
      worktreeRoot !== undefined && (await (deps.pathExists ?? capsulePathExists)(worktreeRoot));

    const compileInput: CompileInput = {
      objective: args.objective,
      acceptance_state: "unverified",
      base_sha: requestedBase ?? "",
      dependencies: [],
      write_fence: [],
      essential_constraints: [],
      check_recipes: [],
      tool_ids: [],
      registry: [],
      artifact_handles: [],
      advisory: {
        memory: advisoryItems(args),
        log_excerpts: [],
      },
    };

    const preflightCodes: string[] =
      repo === undefined
        ? ["project_root_unresolved"]
        : await collectPreflightCodes(repo, worktreeRoot, worktreeReady, requestedBase, deps);

    const compileOptions: CompileOptions = {
      git: {
        // The worktree will be created at the requested base, so an
        // unresolved base still refuses as stale_base via the non-canonical
        // "" path.
        headSha: async (): Promise<string | null> => {
          if (worktreeRoot === undefined || !worktreeReady) {
            return requestedBase;
          }
          const worktreeGit = await gitPort(worktreeRoot);
          return await worktreeGit.head();
        },
        resolveSha: (ref: string): Promise<string | null> =>
          repoGit === null ? Promise.resolve(null) : repoGit.resolveSha(ref),
        isAncestor: (): Promise<boolean | null> => Promise.resolve(null),
      },
      budget: CAPSULE_SHADOW_BUDGET,
    };
    const result = await compile(compileInput, compileOptions);

    const meta = buildEventMeta(result, compileInput, preflightCodes, args, deps.log);
    trimEventMeta(meta);

    const dedupeKey = `${args.handoff_id}:${String(meta["input_hash"])}`;
    if (!testState.dedupeKeys.has(dedupeKey)) {
      rememberDedupeKey(dedupeKey);
      deps.eventLog?.record({
        handoff_id: args.handoff_id,
        source: "daemon",
        kind: CAPSULE_SHADOW_EVENT_KIND,
        ts: (deps.clock ?? ((): Date => new Date()))().toISOString(),
        meta,
      });
    }
  } catch (error) {
    logShadowThrow(deps.log, args.handoff_id, "throw", error);
  }
}

function withShadowTimeout(
  work: Promise<void>,
  handoffId: string,
  log: Logger | undefined,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    const handle = setTimeout(() => {
      log?.warn(
        {
          event: "capsule_shadow_error",
          handoff_id: handoffId,
          reason: "timeout",
          error_name: "TimeoutError",
          error: `capsule shadow exceeded ${String(timeoutMs)}ms`,
        },
        "capsule shadow timed out; dispatch unaffected",
      );
      resolve();
    }, timeoutMs);
    handle.unref();
    timer = handle;
  });
  return Promise.race([work, timeout]).finally((): void => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function runCapsuleShadow(args: CapsuleShadowArgs, deps: CapsuleShadowDeps): Promise<void> {
  return withShadowTimeout(
    shadowWork(args, deps),
    args.handoff_id,
    deps.log,
    deps.timeoutMs ?? CAPSULE_SHADOW_TIMEOUT_MS,
  );
}

export function scheduleCapsuleShadow(
  services: Services,
  buildArgs: () => CapsuleShadowArgs,
): Promise<void> {
  let deps: CapsuleShadowDeps | undefined;
  try {
    deps = {
      compile: compileCapsule,
      preflight: runPreflight,
      gitPort: (root: string): CapsuleGitPort => createCapsuleGitPort({ worktreeRoot: root }),
      probePort: (opts: CapsuleProbePortRequest): ProbePort => createCapsuleProbePort(opts),
      effectiveHooksPath: defaultEffectiveHooksPath,
      pathExists: capsulePathExists,
      homeDir: homedir(),
      timeoutMs: CAPSULE_SHADOW_TIMEOUT_MS,
      log: services.log,
      eventLog: services.dispatchEventLog,
      clock: services.clock,
      ...(testState.depsOverride ?? {}),
    };
    if (testState.inFlightCount >= CAPSULE_SHADOW_MAX_IN_FLIGHT) {
      deps.log?.info(
        { event: "capsule_shadow_skipped", reason: "in_flight_cap" },
        "capsule shadow skipped: in-flight cap reached",
      );
      return Promise.resolve();
    }
    const args = buildArgs();
    testState.inFlightCount += 1;
    // The slot is held until the underlying git work settles, not just until
    // the timeout race — abandoned compiles must not stack up.
    const work = shadowWork(args, deps).finally((): void => {
      testState.inFlightCount -= 1;
    });
    const outer = withShadowTimeout(
      work,
      args.handoff_id,
      deps.log,
      deps.timeoutMs ?? CAPSULE_SHADOW_TIMEOUT_MS,
    );
    testState.inFlight.add(outer);
    void outer.finally((): void => {
      testState.inFlight.delete(outer);
    });
    return outer;
  } catch (error) {
    const log = deps?.log ?? services.log;
    log.warn(
      {
        event: "capsule_shadow_error",
        reason: "throw",
        ...describeError(error),
      },
      "capsule shadow scheduling failed; dispatch unaffected",
    );
    return Promise.resolve();
  }
}

export function setCapsuleShadowDepsForTest(partial: Partial<CapsuleShadowDeps> | null): void {
  testState.depsOverride = partial;
}

export function resetCapsuleShadowStateForTest(): void {
  testState.dedupeKeys.clear();
  testState.inFlight.clear();
  testState.inFlightCount = 0;
}

export function drainCapsuleShadowForTest(): Promise<void> {
  return Promise.all([...testState.inFlight]).then(() => undefined);
}
