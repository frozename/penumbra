import type { WorkflowCtx } from "@penumbra/workflows";

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type TripwireRunResult = { code: number; stdout: string; stderr: string };
export type TripwireRunner = (
  argv: string[],
  opts: { timeoutMs: number },
) => Promise<TripwireRunResult>;

const PER_CALL_TIMEOUT_MS = 4_000;
const TOTAL_BUDGET_MS = 15_000;
const MAX_STATUS_PATHS = 500;
const RECONCILER_SCRATCH_ROOT = join(homedir(), ".penumbra", "rebase-scratch");

export const defaultTripwireRunner: TripwireRunner = async (argv, opts) => {
  const proc = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(
    () => {
      proc.kill();
    },
    Math.max(1, opts.timeoutMs),
  );
  timer.unref();
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) proc.kill();
  }
};

export type PathStat = { size: number; mtimeMs: number } | null;

export type TargetSnapshot = {
  head: string | null;
  // symbolic-ref exit 1 means detached HEAD; other failures invalidate the snapshot.
  branch: string | null;
  statusPaths: Record<string, PathStat>;
  stashes: { sha: string; subject: string }[];
  worktrees: string[];
};

export type HeadMove =
  | { kind: "same" }
  | { kind: "appeared" }
  | { kind: "disappeared" }
  | { kind: "non_descendant" }
  | { kind: "reachable_elsewhere" }
  | { kind: "advanced_local_only" }
  | { kind: "unknown" };

export type ClassifyContext = {
  reviewPaths: ReadonlySet<string>;
  outDirRel: string | null;
  fleetWorktreeRoot: string | null;
};

export type TripwireVerdict = "clean" | "drift" | "mutated" | "unavailable";

export type TripwireMutationKind = "head" | "branch" | "stash" | "worktree" | "path";

export type TripwireMutation = {
  target: string;
  kind: TripwireMutationKind;
  level: "drift" | "mutated";
  text: string;
};

export type TripwireReport = {
  verdict: TripwireVerdict;
  targets: string[];
  deltas: string[];
  /** Per-target, per-class mutation detail — the `deltas` strings tagged so
   *  downstream telemetry can aggregate without re-parsing prose. */
  mutations: TripwireMutation[];
  reason?: string;
  hint?: string;
};

export type TripwireTargets = { targets: string[]; mainCheckout: string | null };

export type CheckoutTripwireSession = { finish: () => Promise<TripwireReport> };

function gitArgs(target: string, args: string[]): string[] {
  // --no-optional-locks: a plain `git status` opportunistically rewrites
  // .git/index; the tripwire must not itself mutate the checkout it watches.
  return ["git", "--no-optional-locks", "-C", target, ...args];
}

async function realpathOrSelf(path: string): Promise<string> {
  return await realpath(path).catch(() => path);
}

export async function resolveTripwireTargets(
  cwd: string,
  runner: TripwireRunner,
  timeoutMs: number,
  callerCwd?: string | null,
): Promise<TripwireTargets | null> {
  const [topRes, commonRes, callerRes] = await Promise.all([
    runner(gitArgs(cwd, ["rev-parse", "--show-toplevel"]), { timeoutMs }).catch(() => null),
    runner(gitArgs(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), {
      timeoutMs,
    }).catch(() => null),
    callerCwd !== undefined && callerCwd !== null && callerCwd.length > 0
      ? runner(gitArgs(callerCwd, ["rev-parse", "--show-toplevel"]), { timeoutMs }).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);
  if (topRes?.code !== 0 || commonRes?.code !== 0) return null;
  const top = topRes.stdout.trim();
  if (top.length === 0) return null;

  const mainCheckoutRaw = commonRes.stdout.trim();
  const realTop = await realpathOrSelf(top);
  const realMain =
    mainCheckoutRaw.length > 0 ? dirname(await realpathOrSelf(mainCheckoutRaw)) : null;
  const callerTop =
    callerRes?.code === 0 && callerRes.stdout.trim().length > 0
      ? await realpathOrSelf(callerRes.stdout.trim())
      : null;

  const targets: string[] = [];
  for (const target of [realTop, realMain, callerTop]) {
    if (target === null) continue;
    if (!targets.includes(target)) targets.push(target);
  }
  return { targets, mainCheckout: realMain };
}

function parseStatusPaths(raw: string): string[] {
  const out: string[] = [];
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.length < 4) continue;
    const xy = token.slice(0, 2);
    out.push(token.slice(3));
    // Porcelain v1 -z rename/copy entries carry the destination then the
    // original as a second NUL-separated token.
    if (xy.includes("R") || xy.includes("C")) {
      const orig = tokens[i + 1];
      if (typeof orig === "string" && orig.length > 0) out.push(orig);
      i += 1;
    }
  }
  return out;
}

function parseStashes(raw: string): { sha: string; subject: string }[] {
  const out: { sha: string; subject: string }[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const cut = line.indexOf("\x1f");
    out.push(
      cut === -1
        ? { sha: line.trim(), subject: "" }
        : { sha: line.slice(0, cut).trim(), subject: line.slice(cut + 1) },
    );
  }
  return out;
}

function parseWorktrees(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) out.push(line.slice("worktree ".length).trim());
  }
  return out;
}

async function statStatusPaths(target: string, raw: string): Promise<Record<string, PathStat>> {
  const paths = parseStatusPaths(raw).slice(0, MAX_STATUS_PATHS);
  const entries = await Promise.all(
    paths.map(async (path) => {
      const rel = path.endsWith("/") ? path.slice(0, -1) : path;
      const info = await stat(join(target, rel)).catch(() => null);
      return [path, info === null ? null : { size: info.size, mtimeMs: info.mtimeMs }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function snapshotTarget(
  target: string,
  runner: TripwireRunner,
  timeoutMs: number,
): Promise<TargetSnapshot | null> {
  try {
    const [headRes, branchRes, statusRes, stashRes, worktreeRes] = await Promise.all([
      runner(gitArgs(target, ["rev-parse", "HEAD"]), { timeoutMs }),
      runner(gitArgs(target, ["symbolic-ref", "--short", "-q", "HEAD"]), { timeoutMs }),
      runner(gitArgs(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), {
        timeoutMs,
      }),
      runner(gitArgs(target, ["stash", "list", "--format=%H%x1f%gs"]), { timeoutMs }),
      runner(gitArgs(target, ["worktree", "list", "--porcelain"]), { timeoutMs }),
    ]);
    if (
      headRes.code !== 0 ||
      (branchRes.code !== 0 && branchRes.code !== 1) ||
      statusRes.code !== 0 ||
      stashRes.code !== 0 ||
      worktreeRes.code !== 0
    )
      return null;
    return {
      head: headRes.stdout.trim().length > 0 ? headRes.stdout.trim() : null,
      branch:
        branchRes.code === 0 && branchRes.stdout.trim().length > 0 ? branchRes.stdout.trim() : null,
      statusPaths: await statStatusPaths(target, statusRes.stdout),
      stashes: parseStashes(stashRes.stdout),
      worktrees: parseWorktrees(worktreeRes.stdout),
    };
  } catch {
    return null;
  }
}

async function resolveHeadMove(
  target: string,
  before: TargetSnapshot,
  after: TargetSnapshot,
  runner: TripwireRunner,
  timeoutMs: number,
  landed: (sha: string) => boolean,
): Promise<HeadMove> {
  if (before.head === after.head) return { kind: "same" };
  if (before.head === null) return { kind: "appeared" };
  if (after.head === null) return { kind: "disappeared" };

  const ancestor = await runner(
    gitArgs(target, ["merge-base", "--is-ancestor", before.head, after.head]),
    { timeoutMs },
  ).catch(() => null);
  if (ancestor === null) return { kind: "unknown" };
  if (ancestor.code === 1) return { kind: "non_descendant" };
  if (ancestor.code !== 0) return { kind: "unknown" };

  if (landed(after.head)) return { kind: "reachable_elsewhere" };
  const refs = await runner(
    gitArgs(target, [
      "for-each-ref",
      "--contains",
      after.head,
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]),
    { timeoutMs },
  ).catch(() => null);
  if (refs?.code !== 0) return { kind: "unknown" };
  const ownRef = after.branch === null ? null : `refs/heads/${after.branch}`;
  const candidates = refs.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== ownRef);
  if (candidates.length > 0) return { kind: "reachable_elsewhere" };
  return { kind: "advanced_local_only" };
}

function isOutDirPath(statusPath: string, outDirRel: string | null): boolean {
  if (outDirRel === null || outDirRel.length === 0) return false;
  if (outDirRel === ".") return true;
  const clean = statusPath.endsWith("/") ? statusPath.slice(0, -1) : statusPath;
  return (
    clean === outDirRel ||
    clean.startsWith(`${outDirRel}/`) ||
    // The porcelain may list an ancestor dir of out_dir (e.g. ".penumbra/")
    // when the run created the tree during the window.
    outDirRel.startsWith(`${clean}/`)
  );
}

function isInsideFleetRoot(path: string, fleetWorktreeRoot: string | null): boolean {
  return (
    fleetWorktreeRoot !== null &&
    (path === fleetWorktreeRoot || path.startsWith(`${fleetWorktreeRoot}/`))
  );
}

function statDelta(before: PathStat | undefined, after: PathStat | undefined): boolean {
  if (before === undefined || after === undefined) return before !== after;
  if (before === null || after === null) return before !== after;
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

export type TripwireDeltaDetail = {
  level: "drift" | "mutated";
  kind: TripwireMutationKind;
  text: string;
};
type Delta = TripwireDeltaDetail;

const HEAD_MOVE_DELTAS: Record<Exclude<HeadMove["kind"], "same">, Delta> = {
  appeared: { level: "mutated", kind: "head", text: "HEAD appeared (first commit created)" },
  disappeared: { level: "mutated", kind: "head", text: "HEAD became unborn" },
  non_descendant: {
    level: "mutated",
    kind: "head",
    text: "HEAD moved to a non-descendant commit",
  },
  advanced_local_only: {
    level: "mutated",
    kind: "head",
    text: "HEAD advanced to commits reachable from no other local ref",
  },
  unknown: { level: "mutated", kind: "head", text: "HEAD moved; ancestry undetermined" },
  reachable_elsewhere: {
    level: "drift",
    kind: "head",
    text: "HEAD fast-forwarded; new head is reachable from another local ref",
  },
};

function headDeltas(before: TargetSnapshot, after: TargetSnapshot, headMove: HeadMove): Delta[] {
  const deltas: Delta[] = [];
  if (before.branch !== after.branch) {
    deltas.push({
      level: "mutated",
      kind: "branch",
      text:
        after.branch === null
          ? `HEAD detached (was branch ${before.branch ?? "detached"})`
          : `branch changed: ${before.branch ?? "detached"} -> ${after.branch}`,
    });
  }
  if (headMove.kind !== "same") deltas.push(HEAD_MOVE_DELTAS[headMove.kind]);
  return deltas;
}

function stashDeltas(before: TargetSnapshot, after: TargetSnapshot): Delta[] {
  const beforeShas = new Set(before.stashes.map((stash) => stash.sha));
  const wipPrefix = before.branch === null ? "WIP on " : `WIP on ${before.branch}:`;
  return after.stashes
    .filter((stash) => !beforeShas.has(stash.sha))
    .map((stash) => ({
      level: stash.subject.startsWith(wipPrefix) ? ("mutated" as const) : ("drift" as const),
      kind: "stash" as const,
      text: `new stash: ${stash.subject}`,
    }));
}

function worktreeDeltas(
  before: TargetSnapshot,
  after: TargetSnapshot,
  fleetWorktreeRoot: string | null,
): Delta[] {
  const beforeWorktrees = new Set(before.worktrees);
  const afterWorktrees = new Set(after.worktrees);
  const deltas: Delta[] = [];
  for (const worktree of after.worktrees) {
    if (beforeWorktrees.has(worktree)) continue;
    deltas.push({
      level:
        isInsideFleetRoot(worktree, fleetWorktreeRoot) ||
        isInsideFleetRoot(worktree, RECONCILER_SCRATCH_ROOT)
          ? "drift"
          : "mutated",
      kind: "worktree",
      text: `worktree added: ${worktree}`,
    });
  }
  for (const worktree of before.worktrees) {
    if (!afterWorktrees.has(worktree)) {
      deltas.push({ level: "drift", kind: "worktree", text: `worktree removed: ${worktree}` });
    }
  }
  return deltas;
}

function statusDeltas(
  before: TargetSnapshot,
  after: TargetSnapshot,
  ctx: ClassifyContext,
): Delta[] {
  const statusPaths = new Set([
    ...Object.keys(before.statusPaths),
    ...Object.keys(after.statusPaths),
  ]);
  const deltas: Delta[] = [];
  for (const path of statusPaths) {
    if (isOutDirPath(path, ctx.outDirRel)) continue;
    if (!statDelta(before.statusPaths[path], after.statusPaths[path])) continue;
    const reviewPath = ctx.reviewPaths.has(path);
    deltas.push({
      level: reviewPath ? "mutated" : "drift",
      kind: "path",
      text: `${reviewPath ? "review " : ""}path changed: ${path}`,
    });
  }
  return deltas;
}

export function classifyTargetSnapshots(args: {
  before: TargetSnapshot;
  after: TargetSnapshot;
  headMove: HeadMove;
  ctx: ClassifyContext;
}): { verdict: "clean" | "drift" | "mutated"; deltas: string[]; deltaDetails: Delta[] } {
  const { before, after, headMove, ctx } = args;
  const deltas = [
    ...headDeltas(before, after, headMove),
    ...stashDeltas(before, after),
    ...worktreeDeltas(before, after, ctx.fleetWorktreeRoot),
    ...statusDeltas(before, after, ctx),
  ];
  const verdict = deltas.some((delta) => delta.level === "mutated")
    ? "mutated"
    : deltas.length > 0
      ? "drift"
      : "clean";
  return { verdict, deltas: deltas.map((delta) => delta.text), deltaDetails: deltas };
}

async function resolveReviewPaths(
  targets: string[],
  cwd: string,
  baseRef: string,
  targetRef: string,
  runner: TripwireRunner,
  timeoutMs: number,
): Promise<Set<string> | null> {
  const paths = new Set<string>();
  const target = targets[0] ?? cwd;
  // Diff in the runner rather than parsing the recalled diff: recall output
  // may be budget-trimmed.
  const diff = await runner(gitArgs(target, ["diff", "--name-only", `${baseRef}...${targetRef}`]), {
    timeoutMs,
  }).catch(() => null);
  if (diff?.code !== 0) return null;
  for (const line of diff.stdout.split("\n")) {
    const path = line.trim();
    if (path.length > 0) paths.add(path);
  }
  return paths;
}

function outDirRelFor(target: string, outDir: string | null): string | null {
  if (outDir === null) return null;
  const rel = relative(target, resolve(outDir));
  if (rel.length === 0) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

// A relative content_path is meaningful in BOTH the scratch checkout (same
// repo-relative path) and the caller's cwd (where the file actually was when
// the caller named it) — resolve against each base and keep every rel that
// lands inside this target. Bases are realpath'd first: targets are real
// paths, and a raw /tmp-vs-/private/tmp spelling would otherwise escape.
async function contentPathRelsFor(
  target: string,
  bases: string[],
  contentPath: string | null | undefined,
): Promise<string[]> {
  if (typeof contentPath !== "string" || contentPath.length === 0) return [];
  const absPaths = isAbsolute(contentPath)
    ? [await realpathOrSelf(contentPath)]
    : await Promise.all(
        bases.map(async (base) => resolve(await realpathOrSelf(base), contentPath)),
      );
  const rels = new Set<string>();
  for (const abs of absPaths) {
    const rel = relative(target, abs);
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) rels.add(rel);
  }
  return [...rels];
}

const VERDICT_RANK: Record<TripwireVerdict, number> = {
  clean: 0,
  drift: 1,
  mutated: 2,
  unavailable: 3,
};

function hasLandDuringWindow(
  opts: Pick<WorkflowCtx, "db" | "project">,
  sha: string,
  startedAt: string,
  finishedAt: string,
): boolean {
  try {
    return Boolean(
      opts
        .db?.()
        .query(
          `SELECT 1 FROM t0_events WHERE event_type = 'dispatch.landed'
       AND source_detail = 'dispatch-land' AND project_id = ? AND ts >= ? AND ts <= ?
       AND json_extract(payload_json, '$.commit_sha') = ? LIMIT 1`,
        )
        .get(opts.project, startedAt, finishedAt, sha),
    );
  } catch {
    return false;
  }
}

type CheckoutTripwireOptions = {
  cwd: string;
  /** The dispatching caller's checkout — resolved to a toplevel and watched
   *  alongside `cwd`'s own top/main so a scratch-rooted run still covers the
   *  operator checkout (P6). */
  callerCwd?: string | null;
  outDir: string | null;
  baseRef: string;
  targetRef: string;
  contentPath?: string | null;
  runner?: TripwireRunner;
  perCallTimeoutMs?: number;
  totalBudgetMs?: number;
  db?: WorkflowCtx["db"];
  project?: string;
};

type TargetClassification = {
  verdict: TripwireVerdict;
  deltas: string[];
  mutations: TripwireMutation[];
  reason?: string;
};

async function classifyOneTarget(args: {
  target: string;
  mainCheckout: string | null;
  beforeSnap: TargetSnapshot | null;
  afterSnap: TargetSnapshot | null;
  reviewPaths: Set<string>;
  fleetWorktreeRoot: string | null;
  opts: CheckoutTripwireOptions;
  startedAt: string;
  runner: TripwireRunner;
  timeout: () => number;
}): Promise<TargetClassification> {
  const {
    target,
    mainCheckout,
    beforeSnap,
    afterSnap,
    reviewPaths,
    fleetWorktreeRoot,
    opts,
    startedAt,
    runner,
    timeout,
  } = args;
  if (beforeSnap === null || afterSnap === null) {
    return {
      verdict: "unavailable",
      deltas: [],
      mutations: [],
      reason: `snapshot failed for ${target} (git failed or timed out)`,
    };
  }
  const headMove = await resolveHeadMove(
    target,
    beforeSnap,
    afterSnap,
    runner,
    timeout(),
    (sha) =>
      target === mainCheckout &&
      opts.project !== undefined &&
      hasLandDuringWindow(
        { db: opts.db, project: opts.project },
        sha,
        startedAt,
        new Date().toISOString(),
      ),
  );
  if (headMove.kind === "unknown") {
    return {
      verdict: "unavailable",
      deltas: [],
      mutations: [],
      reason: `HEAD ancestry lookup failed for ${target}`,
    };
  }
  const targetReviewPaths = new Set(reviewPaths);
  const contentBases =
    opts.callerCwd !== undefined && opts.callerCwd !== null && opts.callerCwd.length > 0
      ? [opts.cwd, opts.callerCwd]
      : [opts.cwd];
  for (const rel of await contentPathRelsFor(target, contentBases, opts.contentPath)) {
    targetReviewPaths.add(rel);
  }
  const classified = classifyTargetSnapshots({
    before: beforeSnap,
    after: afterSnap,
    headMove,
    ctx: {
      reviewPaths: targetReviewPaths,
      outDirRel: outDirRelFor(target, opts.outDir),
      fleetWorktreeRoot,
    },
  });
  return {
    verdict: classified.verdict,
    deltas: classified.deltas.map((delta) => `${target}: ${delta}`),
    mutations: classified.deltaDetails.map((detail) => ({
      target,
      kind: detail.kind,
      level: detail.level,
      text: detail.text,
    })),
  };
}

export async function beginCheckoutTripwire(
  opts: CheckoutTripwireOptions,
): Promise<CheckoutTripwireSession> {
  const startedAt = new Date().toISOString();
  const runner = opts.runner ?? defaultTripwireRunner;
  const perCall = opts.perCallTimeoutMs ?? PER_CALL_TIMEOUT_MS;
  let deadline = Date.now() + (opts.totalBudgetMs ?? TOTAL_BUDGET_MS);
  const timeout = (): number => Math.max(1, Math.min(perCall, deadline - Date.now()));
  const unavailable = (reason: string): CheckoutTripwireSession => ({
    finish: () =>
      Promise.resolve({
        verdict: "unavailable",
        targets: [],
        deltas: [],
        mutations: [],
        reason,
      }),
  });

  let resolved: TripwireTargets | null;
  try {
    resolved = await resolveTripwireTargets(opts.cwd, runner, timeout(), opts.callerCwd);
  } catch {
    resolved = null;
  }
  if (resolved === null || resolved.targets.length === 0) {
    return unavailable(`not a git worktree (or git unavailable): ${opts.cwd}`);
  }

  const { targets, mainCheckout } = resolved;
  const before = new Map<string, TargetSnapshot | null>();
  await Promise.all(
    targets.map(async (target) => {
      before.set(target, await snapshotTarget(target, runner, timeout()));
    }),
  );
  const reviewPaths = await resolveReviewPaths(
    targets,
    opts.cwd,
    opts.baseRef,
    opts.targetRef,
    runner,
    timeout(),
  );
  if (reviewPaths === null) return unavailable("review path diff failed (git failed or timed out)");
  const fleetWorktreeRoot =
    mainCheckout === null
      ? null
      : resolve(process.env["PENUMBRA_WORKTREE_ROOT"] ?? `${mainCheckout}-worktrees`);

  const finish = async (): Promise<TripwireReport> => {
    deadline = Date.now() + (opts.totalBudgetMs ?? TOTAL_BUDGET_MS);
    const deltas: string[] = [];
    const mutations: TripwireMutation[] = [];
    const reasons: string[] = [];
    let verdict: TripwireVerdict = "clean";

    const after = new Map<string, TargetSnapshot | null>();
    await Promise.all(
      targets.map(async (target) => {
        after.set(target, await snapshotTarget(target, runner, timeout()));
      }),
    );

    for (const target of targets) {
      const classified = await classifyOneTarget({
        target,
        mainCheckout,
        beforeSnap: before.get(target) ?? null,
        afterSnap: after.get(target) ?? null,
        reviewPaths,
        fleetWorktreeRoot,
        opts,
        startedAt,
        runner,
        timeout,
      });
      if (VERDICT_RANK[classified.verdict] > VERDICT_RANK[verdict]) {
        verdict = classified.verdict;
      }
      deltas.push(...classified.deltas);
      mutations.push(...classified.mutations);
      if (classified.reason !== undefined) reasons.push(classified.reason);
    }

    const report: TripwireReport = { verdict, targets, deltas, mutations };
    if (reasons.length > 0) report.reason = reasons.join("; ");
    if (
      VERDICT_RANK[verdict] >= VERDICT_RANK.drift &&
      VERDICT_RANK[verdict] < VERDICT_RANK.unavailable
    ) {
      report.hint =
        `A checkout watched by this review changed during the window ` +
        `(targets: ${targets.join(", ")}; not necessarily caused by the review — ` +
        `concurrent reviews and plans share checkouts): ${deltas.join("; ")}. ` +
        `Inspect each target with \`git status\`, \`git stash list\`, ` +
        `\`git worktree list\`.`;
    }
    return report;
  };
  return { finish };
}
