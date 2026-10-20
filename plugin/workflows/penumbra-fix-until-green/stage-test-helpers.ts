import type { ChainStartRequest, DispatchEventInput } from "@penumbra/core";
import type { WorkflowCtx } from "@penumbra/workflows";

import { DispatchEventLog, HandoffWriter, loadSqliteVec, migrate, T0Writer } from "@penumbra/core";
import { Database } from "bun:sqlite";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

export const DEFAULT_INSPECT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type WorktreeInspectFn = NonNullable<WorkflowCtx["worktreeInspect"]>;
type WorktreeInspectReturn = Awaited<ReturnType<WorktreeInspectFn>>;
export type WorktreeInspectionResult = Exclude<WorktreeInspectReturn, null>;

export function makeInspection(
  handoffId: string,
  branchName: string,
  headSha: string,
  dirty: boolean,
): WorktreeInspectionResult {
  return {
    worktree: {
      handoffId,
      path: `/tmp/worktree/${handoffId}`,
      branchName,
      storageRoot: "/tmp/storage",
      createdAt: "2026-09-12T10:00:00.000Z",
      status: "created" as const,
      projectId: "penumbra",
      worktreeMode: "isolated_install" as const,
    },
    diff_against_main: "",
    branch_log: "",
    head_sha: headSha,
    branch_name: branchName,
    dirty,
    truncation: { diff_against_main: false, branch_log: false, total: false },
  };
}

export type InspectMode =
  | "default"
  | "missing"
  | "throws"
  | "dirty"
  | "wrong_handoff"
  | "wrong_branch"
  | "malformed_sha";

export type InspectConfig = {
  pre?: InspectMode;
  post?: InspectMode;
  sha?: string;
  postSha?: string;
};

function resolveInspection(
  handoffId: string,
  branchName: string,
  mode: InspectMode,
  sha: string,
): WorktreeInspectionResult | null {
  switch (mode) {
    case "missing":
      return null;
    case "dirty":
      return makeInspection(handoffId, branchName, sha, true);
    case "wrong_handoff":
      return makeInspection("other-handoff", branchName, sha, false);
    case "wrong_branch":
      return makeInspection(handoffId, "other/branch", sha, false);
    case "malformed_sha":
      return makeInspection(handoffId, branchName, "not-a-full-sha", false);
    case "throws":
      throw new Error("worktree inspect failed");
    case "default":
      return makeInspection(handoffId, branchName, sha, false);
  }
}

export type StageTestCtx = WorkflowCtx & {
  chainStart: (input: ChainStartRequest) => Promise<Response>;
};

function seedResponse(db: Database, responseText: string, agent: string): void {
  new T0Writer(db).write({
    event_id: "stage-response",
    ts: "2026-09-12T10:00:08.000Z",
    ingest_ts: "2026-09-12T10:00:08.000Z",
    source: "agentchat",
    source_detail: "worker",
    project_id: "penumbra",
    user_id: "test",
    machine_id: "test",
    session_id: "stage-conversation",
    event_type: "agent-response",
    lane: "cli-subscription",
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: { response: responseText, handoff_id: "stage-handoff", agent },
    payload_summary: "agent-response",
    origin: "dispatch",
  });
}

type StageTestOptions = {
  chainStartThrows?: boolean;
  awaitThrows?: boolean;
  inspect?: InspectConfig;
  inspectUnavailable?: boolean;
  candidateBranch?: string;
  rootReliability?: "good" | "bad";
  latestReliability?: "good" | "bad";
  persistedBranchBase?: string;
};

function recordReliability(
  db: Database,
  handoffId: string,
  minute: "00" | "01",
  trustworthy: boolean,
): void {
  const events: DispatchEventInput[] = [
    {
      handoff_id: handoffId,
      source: "worker",
      kind: "dispatch.start",
      ts: `2026-09-12T10:${minute}:01.000Z`,
    },
    {
      handoff_id: handoffId,
      source: "worker",
      kind: "proc.spawn",
      ts: `2026-09-12T10:${minute}:02.000Z`,
    },
    {
      handoff_id: handoffId,
      source: "worker",
      kind: "dispatch.end",
      ts: `2026-09-12T10:${minute}:09.000Z`,
      meta: { committed: trustworthy, worktree_changed: true },
    },
  ];
  if (!trustworthy) {
    events.splice(1, 0, {
      handoff_id: handoffId,
      source: "worker",
      kind: "agent.tool_call.failed",
      ts: `2026-09-12T10:${minute}:01.500Z`,
    });
  }
  new DispatchEventLog(db).recordBatch(events);
}

function seedRootStage(
  db: Database,
  input: ChainStartRequest,
  responseText: string | null,
  opts: StageTestOptions,
): void {
  const handoffs = new HandoffWriter({ db });
  handoffs.createApproved({
    handoff_id: "stage-handoff",
    ts: "2026-09-12T10:00:00.000Z",
    project_id: "penumbra",
    conversation_id: "stage-conversation",
    from: "workflow",
    to: input.initial_agent,
    to_role: null,
    message: input.message,
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: input.max_hops ?? 1,
    chain_trust_mode: input.trust_mode ?? "all",
    chain_task_type: input.task_type ?? "review_adversarial",
    use_worktree: input.use_worktree ?? true,
    isolated_install: input.isolated_install,
    dispatch_kind: "workflow",
    parent_handoff_id: null,
    branch_base: opts.persistedBranchBase ?? input.branch_base ?? null,
    branch_name: "stage/branch",
  });
  handoffs.claimDispatch("stage-handoff", "worker-1");
  handoffs.markCompleted("stage-handoff", {
    ts: "2026-09-12T10:00:10.000Z",
    expected_worker_id: "worker-1",
  });
  if (responseText !== null) seedResponse(db, responseText, input.initial_agent);
  recordReliability(db, "stage-handoff", "00", opts.rootReliability !== "bad");
}

function seedLatestStage(db: Database, input: ChainStartRequest, opts: StageTestOptions): void {
  if (opts.latestReliability === undefined) return;
  const handoffs = new HandoffWriter({ db });
  handoffs.createApproved({
    handoff_id: "stage-latest",
    ts: "2026-09-12T10:01:00.000Z",
    project_id: "penumbra",
    conversation_id: "stage-conversation",
    from: "workflow",
    to: input.initial_agent,
    to_role: null,
    message: "[silent-failure-retry] retry",
    triggered_by_event_id: null,
    resolved_by: "test",
    resolved_at: null,
    chain_max_hops: input.max_hops ?? 1,
    chain_trust_mode: input.trust_mode ?? "all",
    chain_task_type: input.task_type ?? "review_adversarial",
    use_worktree: input.use_worktree ?? true,
    isolated_install: input.isolated_install,
    dispatch_kind: "workflow",
    parent_handoff_id: "stage-handoff",
    branch_base: "stage/branch",
    branch_name: "stage/latest",
  });
  handoffs.claimDispatch("stage-latest", "worker-1");
  handoffs.markCompleted("stage-latest", {
    ts: "2026-09-12T10:01:10.000Z",
    expected_worker_id: "worker-1",
  });
  recordReliability(db, "stage-latest", "01", opts.latestReliability !== "bad");
}

function makeChainStart(
  db: Database,
  starts: ChainStartRequest[],
  responseText: string | null,
  opts: StageTestOptions,
): StageTestCtx["chainStart"] {
  return (input) => {
    starts.push(input);
    if (opts.chainStartThrows) return Promise.reject(new Error("chain start failed"));
    seedRootStage(db, input, responseText, opts);
    seedLatestStage(db, input, opts);
    return Promise.resolve(
      Response.json({
        conversation_id: "stage-conversation",
        handoff_id: "stage-handoff",
        branch_name: "stage/branch",
      }),
    );
  };
}

function stageBranch(handoffId: string, candidateBranch: string): string {
  if (handoffId === "stage-latest") return "stage/latest";
  if (handoffId === "stage-handoff") return "stage/branch";
  return candidateBranch;
}

function makeInspect(opts: StageTestOptions): WorktreeInspectFn {
  const inspectCfg = opts.inspect ?? {};
  const preMode = inspectCfg.pre ?? "default";
  const postMode = inspectCfg.post ?? "default";
  const preSha = inspectCfg.sha ?? DEFAULT_INSPECT_SHA;
  const postSha = inspectCfg.postSha ?? preSha;
  const candidateBranch = opts.candidateBranch ?? "feature/candidate";
  const calls = new Map<string, number>();
  return (handoffId) => {
    const callIndex = calls.get(handoffId) ?? 0;
    calls.set(handoffId, callIndex + 1);
    const isCandidate = handoffId === "handoff-1";
    const mode = isCandidate && callIndex > 0 ? postMode : isCandidate ? preMode : "default";
    const sha = isCandidate && callIndex > 0 ? postSha : preSha;
    if (mode === "throws") return Promise.reject(new Error("worktree inspect failed"));
    return Promise.resolve(
      resolveInspection(handoffId, stageBranch(handoffId, candidateBranch), mode, sha),
    );
  };
}

export function stageTestCtx(
  responseText: string | null,
  opts: StageTestOptions = {},
): { ctx: StageTestCtx; starts: ChainStartRequest[]; timeouts: number[] } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const starts: ChainStartRequest[] = [];
  const timeouts: number[] = [];
  const ctx: StageTestCtx = {
    dispatch: () => Promise.reject(new Error("legacy dispatch must not be used")),
    awaitChain: (_conversationId, awaitOpts) => {
      if (opts.awaitThrows) return Promise.reject(new Error("await failed"));
      if (awaitOpts?.timeoutMs !== undefined) timeouts.push(awaitOpts.timeoutMs);
      return Promise.resolve({
        status: "completed" as const,
        final_agent: "stage",
        response_text: responseText,
      });
    },
    cancel: () => Promise.resolve(),
    fileWrite: (path) => Promise.resolve(path),
    config: {},
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "penumbra",
    args: {},
    db: () => db,
    chainStart: makeChainStart(db, starts, responseText, opts),
    ...(opts.inspectUnavailable ? {} : { worktreeInspect: makeInspect(opts) }),
  };
  return { ctx, starts, timeouts };
}
