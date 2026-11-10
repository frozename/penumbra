import {
  type HoldoutLock,
  type HoldoutLockEntry,
  type RootRef,
  RootRefSchema,
} from "@penumbra/core/evals/fixture";
import {
  type IssueClosureEvidence,
  type PublicFixEvidence,
  verifyHoldoutLock,
} from "@penumbra/core/evals/holdout";
import { z } from "zod";

import { defaultRunCommand, type RunCommand } from "./grader/materialize.js";

export class HoldoutAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoutAuditError";
  }
}

interface ReservationCollision {
  commit: string;
  path: string;
  fixture_family_id: string;
  fixture_variant_id: string;
  lock_family_id: string;
  lock_variant_id: string;
  via: "root" | "reconstructs" | "unparseable";
}

interface ReservationResult {
  ok: boolean;
  collisions: ReservationCollision[];
}

interface AuditResult {
  head_sha: string;
  evidence: PublicFixEvidence;
  reservation: ReservationResult;
}

interface AuditHoldoutRootsOpts {
  repoRoot: string;
  lock: unknown;
  readGoodPatch: (entry: HoldoutLockEntry) => Promise<string>;
  run?: RunCommand;
  ghRepo?: string;
  fixturesPrefix?: string;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const FIXTURES_PREFIX_DEFAULT = "packages/agentchat/test/fixtures/evals/";

function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  return env;
}

function rootEquals(a: RootRef, b: RootRef): boolean {
  if (a.kind === "issue" && b.kind === "issue") return a.number === b.number;
  if (a.kind !== "issue" && b.kind !== "issue") return a.kind === b.kind && a.id === b.id;
  return false;
}

function parseSha(text: string, label: string): string {
  const trimmed = text.trim();
  if (!FULL_SHA_RE.test(trimmed)) {
    throw new HoldoutAuditError(`${label} returned invalid sha: ${JSON.stringify(trimmed)}`);
  }
  return trimmed;
}

function parsePatchIdFirstToken(output: string): string {
  const firstLine = (output.split("\n")[0] ?? "").trim();
  const token = firstLine.split(" ")[0] ?? "";
  if (!FULL_SHA_RE.test(token)) {
    throw new HoldoutAuditError("patch-id produced no valid patch-id hash");
  }
  return token;
}

async function gitShaHead(repoRoot: string, run: RunCommand): Promise<string> {
  const res = await run("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    env: scrubbedGitEnv(),
  });
  if (res.code !== 0) {
    throw new HoldoutAuditError("git rev-parse HEAD exited non-zero");
  }
  return parseSha(res.stdout.toString("utf8"), "git rev-parse HEAD");
}

interface HistoryScan {
  historyIds: Set<string>;
  historyAdded: string[];
}

async function scanHistory(repoRoot: string, run: RunCommand): Promise<HistoryScan> {
  const logRes = await run(
    "git",
    ["log", "--all", "-p", "--no-color", "--no-ext-diff", "--no-textconv"],
    {
      cwd: repoRoot,
      env: scrubbedGitEnv(),
    },
  );
  if (logRes.code !== 0) {
    throw new HoldoutAuditError("git log --all -p exited non-zero");
  }
  const logText = logRes.stdout.toString("utf8");

  const patchIdRes = await run("git", ["patch-id", "--stable"], {
    cwd: repoRoot,
    env: scrubbedGitEnv(),
    input: logRes.stdout,
  });
  if (patchIdRes.code !== 0) {
    throw new HoldoutAuditError("git patch-id --stable exited non-zero");
  }
  const patchIdOut = patchIdRes.stdout.toString("utf8");
  const historyIds = new Set<string>();
  for (const line of patchIdOut.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const token = trimmed.split(" ")[0] ?? "";
    historyIds.add(token);
  }

  const historyAdded: string[] = [];
  for (const line of logText.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      historyAdded.push(line.slice(1));
    }
  }

  return { historyIds, historyAdded };
}

interface PatchIdResult {
  patch_id: string;
  patch_id_hits: number;
}

async function computePatchId(
  patch: string,
  historyScan: HistoryScan,
  run: RunCommand,
  repoRoot: string,
): Promise<PatchIdResult> {
  const patchBuf = Buffer.from(patch);
  const res = await run("git", ["patch-id", "--stable"], {
    cwd: repoRoot,
    env: scrubbedGitEnv(),
    input: patchBuf,
  });
  if (res.code !== 0) {
    throw new HoldoutAuditError("git patch-id --stable exited non-zero on patch");
  }
  const patchId = parsePatchIdFirstToken(res.stdout.toString("utf8"));

  const patchIdHits = historyScan.historyIds.has(patchId) ? 1 : 0;

  return { patch_id: patchId, patch_id_hits: patchIdHits };
}

interface AddedLineResult {
  added_line_hits: number;
}

function computeAddedLineHits(patch: string, historyScan: HistoryScan): AddedLineResult {
  const top5 = computeTop5PatchLines(patch);
  let addedLineHits = 0;
  for (const c of top5) {
    const trimmed = c.trim();
    for (const h of historyScan.historyAdded) {
      if (h.includes(trimmed)) {
        addedLineHits++;
        break;
      }
    }
  }
  return { added_line_hits: addedLineHits };
}

function computeTop5PatchLines(patch: string): string[] {
  const patchLines: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      patchLines.push(line.slice(1));
    }
  }

  const candidates: string[] = [];
  for (const line of patchLines) {
    const nonWs = line.replaceAll(/\s/g, "").length;
    if (nonWs >= 24) {
      candidates.push(line);
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      unique.push(c);
    }
  }

  unique.sort((a, b) => {
    const na = a.replaceAll(/\s/g, "").length;
    const nb = b.replaceAll(/\s/g, "").length;
    if (nb !== na) return nb - na;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return unique.slice(0, 5);
}

interface GhIssueViewResult {
  state: "OPEN" | "CLOSED";
  closedByPullRequestsReferences: {
    number: number;
    url: string;
    repository: { name: string; owner: { login: string } };
  }[];
}

const GhIssueSchema = z.object({
  state: z.enum(["OPEN", "CLOSED"]),
  closedByPullRequestsReferences: z.array(
    z.object({
      number: z.number().int(),
      url: z.string(),
      repository: z.object({
        name: z.string(),
        owner: z.object({ login: z.string() }),
      }),
    }),
  ),
});

const GhPrSchema = z.object({
  mergeCommit: z.object({ oid: z.string() }).nullable(),
});

interface ClosingCommit {
  sha: string;
  is_ancestor_of_head: boolean;
}

async function computeIssueClosure(
  entry: HoldoutLockEntry,
  repoRoot: string,
  headSha: string,
  run: RunCommand,
  ghRepo: string | undefined,
): Promise<IssueClosureEvidence | null> {
  if (entry.root.kind !== "issue") {
    return null;
  }

  const issueData = await fetchIssueData(
    entry as { root: { kind: "issue"; number: number } },
    repoRoot,
    run,
    ghRepo,
  );
  if (issueData === null) {
    return null;
  }

  if (issueData.state === "OPEN") {
    return { state: "OPEN", closing_commits: [] };
  }

  return await processClosedIssue(issueData, repoRoot, headSha, run, ghRepo);
}

interface FetchedIssue {
  state: "OPEN" | "CLOSED";
  refs: {
    number: number;
    url: string;
    repository: { name: string; owner: { login: string } };
  }[];
}

async function fetchIssueData(
  entry: { root: { kind: "issue"; number: number } },
  repoRoot: string,
  run: RunCommand,
  ghRepo: string | undefined,
): Promise<FetchedIssue | null> {
  const ghArgs: string[] = [
    "issue",
    "view",
    String(entry.root.number),
    "--json",
    "state,closedByPullRequestsReferences",
  ];
  if (ghRepo !== undefined) {
    ghArgs.push("--repo", ghRepo);
  }

  const issueRes = await run("gh", ghArgs, {
    cwd: repoRoot,
    env: scrubbedGitEnv(),
  });

  if (issueRes.code !== 0) {
    return null;
  }

  let issueParsed: unknown;
  try {
    issueParsed = JSON.parse(issueRes.stdout.toString("utf8"));
  } catch {
    return null;
  }

  const issueResult = GhIssueSchema.safeParse(issueParsed);
  if (!issueResult.success) {
    return null;
  }

  return {
    state: issueResult.data.state,
    refs: issueResult.data.closedByPullRequestsReferences,
  };
}

async function processClosedIssue(
  issue: FetchedIssue,
  repoRoot: string,
  headSha: string,
  run: RunCommand,
  ghRepo: string | undefined,
): Promise<IssueClosureEvidence | null> {
  const closingCommits: ClosingCommit[] = [];

  for (const ref of issue.refs) {
    if (!checkCrossRepo(ref, ghRepo)) {
      return null;
    }

    const mergeResult = await fetchMergeCommit(ref, repoRoot, run);
    if (mergeResult.kind === "lookup_failed") {
      return null;
    }
    if (mergeResult.kind === "not_merged") {
      continue;
    }

    const isAncestor = await checkIsAncestor(mergeResult.oid, headSha, repoRoot, run);
    if (isAncestor === null) {
      return null;
    }

    closingCommits.push({ sha: mergeResult.oid, is_ancestor_of_head: isAncestor });
  }

  return { state: "CLOSED", closing_commits: closingCommits };
}

function checkCrossRepo(
  ref: { repository: { name: string; owner: { login: string } } },
  ghRepo: string | undefined,
): boolean {
  if (ghRepo === undefined) return true;
  const refRepo = `${ref.repository.owner.login}/${ref.repository.name}`.toLowerCase();
  return refRepo === ghRepo.toLowerCase();
}

type MergeCommitResult =
  | { kind: "merged"; oid: string }
  | { kind: "not_merged" }
  | { kind: "lookup_failed" };

async function fetchMergeCommit(
  ref: { url: string },
  repoRoot: string,
  run: RunCommand,
): Promise<MergeCommitResult> {
  const prRes = await run("gh", ["pr", "view", ref.url, "--json", "mergeCommit"], {
    cwd: repoRoot,
    env: scrubbedGitEnv(),
  });

  if (prRes.code !== 0) {
    return { kind: "lookup_failed" };
  }

  let prParsed: unknown;
  try {
    prParsed = JSON.parse(prRes.stdout.toString("utf8"));
  } catch {
    return { kind: "lookup_failed" };
  }

  const prResult = GhPrSchema.safeParse(prParsed);
  if (!prResult.success) {
    return { kind: "lookup_failed" };
  }

  const mergeCommit = prResult.data.mergeCommit;
  if (mergeCommit === null) {
    return { kind: "not_merged" };
  }

  return { kind: "merged", oid: mergeCommit.oid };
}

async function checkIsAncestor(
  oid: string,
  headSha: string,
  repoRoot: string,
  run: RunCommand,
): Promise<boolean | null> {
  const mergeBaseRes = await run("git", ["merge-base", "--is-ancestor", oid, headSha], {
    cwd: repoRoot,
    env: scrubbedGitEnv(),
  });

  if (mergeBaseRes.code === 0) return true;
  if (mergeBaseRes.code === 1) return false;
  return null;
}

async function auditNonSyntheticEntries(
  lock: HoldoutLock,
  headSha: string,
  repoRoot: string,
  run: RunCommand,
  readGoodPatch: (entry: HoldoutLockEntry) => Promise<string>,
  ghRepo: string | undefined,
): Promise<PublicFixEvidence> {
  const nonSynthetic = lock.entries.filter((e) => !e.synthetic);
  if (nonSynthetic.length === 0) {
    return {};
  }

  const historyScan = await scanHistory(repoRoot, run);
  const evidence: PublicFixEvidence = {};

  for (const entry of nonSynthetic) {
    const key = `${entry.family_id}/${entry.variant_id}`;
    const patch = await readGoodPatch(entry);
    const result = await computeEntryEvidence(
      patch,
      historyScan,
      entry,
      repoRoot,
      headSha,
      run,
      ghRepo,
    );

    evidence[key] = result;
  }

  return evidence;
}

async function computeEntryEvidence(
  patch: string,
  historyScan: HistoryScan,
  entry: HoldoutLockEntry,
  repoRoot: string,
  headSha: string,
  run: RunCommand,
  ghRepo: string | undefined,
): Promise<EvidenceEntry> {
  const { patch_id_hits } = await computePatchId(patch, historyScan, run, repoRoot);
  const { added_line_hits } = computeAddedLineHits(patch, historyScan);
  const issue_closure = await computeIssueClosure(entry, repoRoot, headSha, run, ghRepo);

  return {
    issue_closure,
    patch_id_hits,
    added_line_hits,
    head_sha: headSha,
  } satisfies EvidenceEntry;
}

type EvidenceEntry = {
  issue_closure: IssueClosureEvidence | null;
  patch_id_hits: number;
  added_line_hits: number;
  head_sha: string;
};

interface FixtureBlob {
  commit: string;
  path: string;
  data: Record<string, unknown>;
}

async function scanFixtures(
  repoRoot: string,
  run: RunCommand,
  fixturesPrefix: string,
): Promise<FixtureBlob[]> {
  const res = await run(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "log",
      "--all",
      "--root",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--diff-filter=AM",
      "--format=commit:%H",
      "--",
      fixturesPrefix,
    ],
    {
      cwd: repoRoot,
      env: scrubbedGitEnv(),
    },
  );

  if (res.code !== 0) {
    throw new HoldoutAuditError("git log --raw reservation scan exited non-zero");
  }

  const output = res.stdout.toString("utf8");
  const blobs: FixtureBlob[] = [];
  const oidCache = new Map<string, Buffer>();
  let currentCommit = "";

  for (const line of output.split("\n")) {
    if (line.startsWith("commit:")) {
      currentCommit = line.slice(7);
      continue;
    }

    const parsed = parseFixtureLine(line, currentCommit);
    if (parsed === null) continue;

    const { path, blobOid } = parsed;
    const blobBuf = await getBlob(repoRoot, run, blobOid, oidCache);
    const data = parseBlobData(blobBuf);
    blobs.push({ commit: currentCommit, path, data });
  }

  return blobs;
}

interface FixtureLine {
  path: string;
  blobOid: string;
}

function parseFixtureLine(line: string, currentCommit: string): FixtureLine | null {
  const tabIdx = line.indexOf("\t");
  if (tabIdx < 0) return null;

  const meta = line.slice(0, tabIdx);
  const path = line.slice(tabIdx + 1);

  if (!path.endsWith("/fixture.json")) return null;

  const parts = meta.split(" ");
  if (parts.length < 4) return null;

  const blobOid = parts[3];
  if (blobOid === undefined) return null;

  return { path, blobOid };
}

async function getBlob(
  repoRoot: string,
  run: RunCommand,
  blobOid: string,
  oidCache: Map<string, Buffer>,
): Promise<Buffer> {
  const cached = oidCache.get(blobOid);
  if (cached !== undefined) {
    return cached;
  }

  const catRes = await run("git", ["cat-file", "blob", blobOid], {
    cwd: repoRoot,
    env: scrubbedGitEnv(),
  });
  if (catRes.code !== 0) {
    throw new HoldoutAuditError("git cat-file blob exited non-zero");
  }
  oidCache.set(blobOid, catRes.stdout);
  return catRes.stdout;
}

function parseBlobData(blobBuf: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(blobBuf.toString("utf8")) as Record<string, unknown>;
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function extractFixtureIds(data: Record<string, unknown>): {
  family_id: string;
  variant_id: string;
} {
  const fid = data["family_id"];
  const vid = data["variant_id"];
  return {
    family_id: typeof fid === "string" ? fid : "",
    variant_id: typeof vid === "string" ? vid : "",
  };
}

async function computeReservation(
  lock: HoldoutLock,
  repoRoot: string,
  run: RunCommand,
  fixturesPrefix: string,
): Promise<ReservationResult> {
  const nonSynthetic = lock.entries.filter((e) => !e.synthetic);
  if (nonSynthetic.length === 0) {
    return { ok: true, collisions: [] };
  }

  const fixtureBlobs = await scanFixtures(repoRoot, run, fixturesPrefix);
  const collisions: ReservationCollision[] = [];

  for (const fb of fixtureBlobs) {
    const parsedRoot = parseRootRef(fb.data["root"]);
    const parsedReconstructs = parseRootRefNullable(fb.data["reconstructs"]);
    const { family_id: fixtureFamilyId, variant_id: fixtureVariantId } = extractFixtureIds(fb.data);

    if (parsedRoot === null && parsedReconstructs === null) {
      pushUnparseableCollisions(collisions, fb, fixtureFamilyId, fixtureVariantId);
      continue;
    }

    for (const entry of nonSynthetic) {
      const via = detectCollisionVia(parsedRoot, parsedReconstructs, entry);
      if (via !== null) {
        collisions.push({
          commit: fb.commit,
          path: fb.path,
          fixture_family_id: fixtureFamilyId,
          fixture_variant_id: fixtureVariantId,
          lock_family_id: entry.family_id,
          lock_variant_id: entry.variant_id,
          via,
        });
      }
    }
  }

  collisions.sort(compareCollision);

  return { ok: collisions.length === 0, collisions };
}

function compareCollision(a: ReservationCollision, b: ReservationCollision): number {
  const r1 = compareString(a.commit, b.commit);
  if (r1 !== 0) return r1;
  const r2 = compareString(a.path, b.path);
  if (r2 !== 0) return r2;
  const r3 = compareString(a.lock_family_id, b.lock_family_id);
  if (r3 !== 0) return r3;
  const r4 = compareString(a.lock_variant_id, b.lock_variant_id);
  if (r4 !== 0) return r4;
  return a.via < b.via ? -1 : a.via > b.via ? 1 : 0;
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseRootRef(root: unknown): RootRef | null {
  const result = RootRefSchema.safeParse(root);
  if (result.success) return result.data;
  return null;
}

function parseRootRefNullable(root: unknown): RootRef | null {
  const result = RootRefSchema.nullable().safeParse(root);
  if (result.success) return result.data;
  return null;
}

function detectCollisionVia(
  parsedRoot: RootRef | null,
  parsedReconstructs: RootRef | null,
  entry: HoldoutLockEntry,
): "root" | "reconstructs" | null {
  if (parsedRoot !== null && rootEquals(parsedRoot, entry.root)) {
    return "root";
  }
  if (parsedReconstructs !== null && rootEquals(parsedReconstructs, entry.root)) {
    return "reconstructs";
  }
  return null;
}

function pushUnparseableCollisions(
  collisions: ReservationCollision[],
  fb: FixtureBlob,
  fixtureFamilyId: string,
  fixtureVariantId: string,
): void {
  collisions.push({
    commit: fb.commit,
    path: fb.path,
    fixture_family_id: fixtureFamilyId,
    fixture_variant_id: fixtureVariantId,
    lock_family_id: "",
    lock_variant_id: "",
    via: "unparseable",
  });
}

export async function auditHoldoutRoots(opts: AuditHoldoutRootsOpts): Promise<AuditResult> {
  const lock = verifyHoldoutLock(opts.lock);
  const run = opts.run ?? defaultRunCommand;
  const repoRoot = opts.repoRoot;
  const ghRepo = opts.ghRepo;
  const fixturesPrefix = opts.fixturesPrefix ?? FIXTURES_PREFIX_DEFAULT;

  const headSha = await gitShaHead(repoRoot, run);
  const evidence = await auditNonSyntheticEntries(
    lock,
    headSha,
    repoRoot,
    run,
    opts.readGoodPatch,
    ghRepo,
  );
  const reservation = await computeReservation(lock, repoRoot, run, fixturesPrefix);

  return { head_sha: headSha, evidence, reservation };
}
