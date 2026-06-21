import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

type TaskPriority = "low" | "normal" | "high" | "urgent";

interface TaskRecord {
  id: string;
  created_at: number;
  updated_at: number;
  created_by_kind: string;
  created_by_id: string;
  parent_task_id: string | null;
  kind: string;
  priority: TaskPriority;
  prompt: string;
  acceptance_criteria: string | null;
  expected_artifacts: unknown[] | null;
  eligibility: Record<string, unknown>;
  review_eligibility: Record<string, unknown> | null;

  requires_review: boolean;
  status: string;
  result_summary: string | null;
  result_artifacts: unknown[] | null;
  failure_reason: string | null;
  chain_id: string | null;
  origin: string | null;
  lease?: unknown;
  events?: unknown[] | null;
}

interface TaskListResponse {
  tasks: TaskRecord[];
}

type TaskShowResponse = TaskRecord;

interface MaestroSessionResponse {
  task_id: string;
  agent_id: string;
  chain_handoff_id: string | null;
  started_at: number;
  wall_clock_budget_ms: number;
  cost_consumed_cents: number | null;
  cost_budget_cents: number;
  sub_dispatches_consumed: number | null;
  sub_dispatch_budget: number;
  soft_warned_at: number | null;
  terminated_at: number | null;
  termination_reason: string | null;
}

interface TaskLeaseResponse {
  task_id: string;
  lease_id: string;
  expires_at: number;
}

export interface RunTaskNewOpts {
  prompt?: string;
  priority?: TaskPriority;
  kind?: string;
  require_tags?: string[];
  min_tier?: string;
  require_review?: boolean;
  acceptance?: string;
  allow_agents?: string[];
  bounds_wall_clock_min?: number;
  bounds_cost_cents?: number;
  bounds_sub_dispatches?: number;
  gh_repo?: string;
  gh_title?: string;
  gh_body?: string;
  gh_labels?: string[];
  gh_assignees?: string[];
  from_file?: string;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

export interface RunTaskListOpts {
  status?: string;
  kind?: string;
  mine?: boolean;
  json: boolean;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

export interface RunTaskShowOpts {
  id: string;
  json: boolean;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

export interface RunTaskCancelOpts {
  id: string;
  reason?: string;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

export interface RunTaskReviewOpts {
  id: string;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
  editor?: string;
}

export interface RunTaskWatchOpts {
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

function defaultPrint(line: string): void {
  process.stdout.write(`${line}\n`);
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const port = Number(readFileSync(join(storageRoot, "port"), "utf8").trim());
  const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`penumbra task: invalid daemon port in ${join(storageRoot, "port")}`);
  }
  if (!token) {
    throw new Error(`penumbra task: empty daemon token in ${join(storageRoot, "token")}`);
  }
  return { baseUrl: `http://127.0.0.1:${String(port)}`, token };
}

function buildDaemonUrl(
  fetchOverride: typeof fetch | undefined,
  daemon: { baseUrl: string } | null,
  path: string,
): string {
  if (fetchOverride) return path;
  if (!daemon) throw new Error("penumbra task: daemon not resolved");
  return `${daemon.baseUrl}${path}`;
}

function prettyTask(task: TaskRecord): string {
  return [
    `${task.id} [${task.status}]`,
    `priority=${task.priority}`,
    `kind=${task.kind}`,
    `created_by=${task.created_by_kind}:${task.created_by_id}`,
    `prompt=${task.prompt}`,
  ].join("\n");
}

function formatTimestamp(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  return new Date(ts).toISOString();
}

function formatElapsedMinutes(startedAt: number): number {
  return Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
}

function formatMsMinutes(ms: number | null | undefined): string {
  const safeMs = Number.isFinite(ms ?? NaN) ? Math.max(0, ms ?? 0) : 0;
  return `${(safeMs / 60_000).toFixed(1)}m`;
}

function formatPercent(
  consumed: number | null | undefined,
  budget: number | null | undefined,
): number {
  if (!Number.isFinite(consumed ?? NaN) || !Number.isFinite(budget ?? NaN) || (budget ?? 0) <= 0)
    return 0;
  return Math.round(((consumed ?? 0) / (budget ?? 1)) * 100);
}

function formatDollars(cents: number | null | undefined): string {
  const safeCents = Number.isFinite(cents ?? NaN) ? Math.max(0, cents ?? 0) : 0;
  return `$${(safeCents / 100).toFixed(2)}`;
}

function renderStatus(session: MaestroSessionResponse): string {
  if (session.terminated_at === null) return "running";
  return `terminated:${session.termination_reason ?? "unknown"}`;
}

function prettyMaestroSession(session: MaestroSessionResponse): string {
  const wallClockUsedMs =
    session.terminated_at === null
      ? Date.now() - session.started_at
      : session.terminated_at - session.started_at;
  const wallPct = formatPercent(wallClockUsedMs, session.wall_clock_budget_ms);
  const costPct = formatPercent(session.cost_consumed_cents, session.cost_budget_cents);
  const subPct = formatPercent(session.sub_dispatches_consumed, session.sub_dispatch_budget);
  return [
    "Maestro session",
    `  agent:               ${session.agent_id}`,
    `  chain:               ${session.chain_handoff_id ?? "—"}`,
    `  started:             ${formatTimestamp(session.started_at)} (${String(formatElapsedMinutes(session.started_at))}m ago)`,
    `  wall clock:          ${formatMsMinutes(wallClockUsedMs)} / ${formatMsMinutes(session.wall_clock_budget_ms)}  (${String(wallPct)}%)`,
    `  cost:                ${formatDollars(session.cost_consumed_cents)} / ${formatDollars(session.cost_budget_cents)}  (${String(costPct)}%)`,
    `  sub-dispatches:      ${String(session.sub_dispatches_consumed ?? 0)} / ${String(session.sub_dispatch_budget)}  (${String(subPct)}%)`,
    `  warned at:           ${formatTimestamp(session.soft_warned_at)}`,
    `  status:              ${renderStatus(session)}`,
  ].join("\n");
}

async function tryFetchMaestroSession(opts: {
  id: string;
  storageRoot: string;
  fetch?: typeof fetch;
  daemon: { baseUrl: string; token: string } | null;
}): Promise<MaestroSessionResponse | null> {
  try {
    const res = await (opts.fetch ?? fetch)(
      buildDaemonUrl(opts.fetch, opts.daemon, `/maestro/sessions/${opts.id}`),
      {
        headers: opts.daemon ? { authorization: `Bearer ${opts.daemon.token}` } : undefined,
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return (await res.json()) as MaestroSessionResponse;
  } catch {
    return null;
  }
}

function buildNewTaskPayload(opts: RunTaskNewOpts): Record<string, unknown> {
  if (!opts.prompt) {
    throw new Error("penumbra task new: --prompt is required when not using --from-file");
  }
  if (opts.kind === "orchestrate" && (opts.allow_agents ?? []).length === 0) {
    throw new Error("penumbra task new: kind=orchestrate requires at least one --allow-agent");
  }
  const eligibility: Record<string, unknown> = {};
  if ((opts.require_tags ?? []).length > 0) eligibility.required_tags = opts.require_tags;
  if (opts.min_tier) eligibility.min_tier = opts.min_tier;
  if ((opts.allow_agents ?? []).length > 0) eligibility.allow_agents = opts.allow_agents;
  const bounds: Record<string, unknown> = {};
  if (opts.bounds_wall_clock_min !== undefined)
    bounds.wall_clock_ms = opts.bounds_wall_clock_min * 60_000;
  if (opts.bounds_cost_cents !== undefined) bounds.cost_cents = opts.bounds_cost_cents;
  if (opts.bounds_sub_dispatches !== undefined)
    bounds.max_sub_dispatches = opts.bounds_sub_dispatches;
  const payload: Record<string, unknown> = {
    prompt: opts.prompt,
    priority: opts.priority ?? "normal",
    eligibility: Object.keys(eligibility).length > 0 ? eligibility : undefined,
    bounds: Object.keys(bounds).length > 0 ? bounds : undefined,
    requires_review: opts.require_review ?? false,
    acceptance_criteria: opts.acceptance,
    created_by_kind: "human",
    created_by_id: "cli",
    kind: opts.kind ?? "work",
  };
  applyGhCreate(payload, opts);
  return payload;
}

function applyGhCreate(payload: Record<string, unknown>, opts: RunTaskNewOpts): void {
  if (!opts.gh_repo) return;
  payload.gh_create = {
    repo: opts.gh_repo,
    title: opts.gh_title,
    body: opts.gh_body,
    labels: (opts.gh_labels ?? []).length > 0 ? opts.gh_labels : undefined,
    assignees: (opts.gh_assignees ?? []).length > 0 ? opts.gh_assignees : undefined,
  };
}

export async function runTaskNew(opts: RunTaskNewOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const body = opts.from_file
    ? (YAML.parse(await Bun.file(resolve(opts.from_file)).text()) as Record<string, unknown>)
    : buildNewTaskPayload(opts);
  if (opts.from_file) {
    applyGhCreate(body, opts);
  }
  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const res = await (opts.fetch ?? fetch)(buildDaemonUrl(opts.fetch, daemon, "/tasks"), {
    method: "POST",
    headers: {
      ...(daemon ? { authorization: `Bearer ${daemon.token}` } : {}),
      "content-type": "application/json",
      "x-penumbra-origin": "cli",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`penumbra task new: daemon /tasks returned HTTP ${String(res.status)}`);
  const created = (await res.json()) as {
    task_id: string;
    gh_issue_url?: string;
    gh_create_status?: "queued" | "pending" | "created" | "failed";
    gh_create_error?: string | null;
  };
  print(created.task_id);
  if (created.gh_issue_url) {
    print(created.gh_issue_url);
  }
  if (created.gh_create_status) {
    print(`gh_create_status=${created.gh_create_status}`);
  }
  if (created.gh_create_error) {
    print(`gh_create_error=${created.gh_create_error}`);
  }
}

export async function runTaskList(opts: RunTaskListOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.mine) params.set("origin", "cli");
  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const res = await (opts.fetch ?? fetch)(
    buildDaemonUrl(opts.fetch, daemon, `/tasks?${params.toString()}`),
    {
      headers: daemon ? { authorization: `Bearer ${daemon.token}` } : undefined,
    },
  );
  if (!res.ok)
    throw new Error(`penumbra task list: daemon /tasks returned HTTP ${String(res.status)}`);
  const body = (await res.json()) as TaskListResponse;
  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }
  if (body.tasks.length === 0) {
    print("(no tasks)");
    return;
  }
  for (const task of body.tasks) print(prettyTask(task));
}

export async function runTaskShow(opts: RunTaskShowOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const res = await (opts.fetch ?? fetch)(
    buildDaemonUrl(opts.fetch, daemon, `/tasks/${opts.id}?include=lease,events`),
    {
      headers: daemon ? { authorization: `Bearer ${daemon.token}` } : undefined,
    },
  );
  if (!res.ok)
    throw new Error(
      `penumbra task show: daemon /tasks/${opts.id} returned HTTP ${String(res.status)}`,
    );
  const body = (await res.json()) as TaskShowResponse;
  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }
  print(prettyTask(body));
  if (body.kind === "orchestrate") {
    const session = await tryFetchMaestroSession({
      id: body.id,
      storageRoot: opts.storageRoot,
      fetch: opts.fetch,
      daemon,
    });
    if (session) print(prettyMaestroSession(session));
  }
}

export async function runTaskCancel(opts: RunTaskCancelOpts): Promise<void> {
  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const res = await (opts.fetch ?? fetch)(
    buildDaemonUrl(opts.fetch, daemon, `/tasks/${opts.id}/cancel`),
    {
      method: "POST",
      headers: {
        ...(daemon ? { authorization: `Bearer ${daemon.token}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: opts.reason }),
    },
  );
  if (!res.ok)
    throw new Error(
      `penumbra task cancel: daemon /tasks/${opts.id}/cancel returned HTTP ${String(res.status)}`,
    );
}

export async function runTaskReview(opts: RunTaskReviewOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const leaseRes = await (opts.fetch ?? fetch)(buildDaemonUrl(opts.fetch, daemon, "/tasks/lease"), {
    method: "POST",
    headers: {
      ...(daemon ? { authorization: `Bearer ${daemon.token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ agent_id: "cli-human" }),
  });
  if (leaseRes.status !== 200) {
    print(`task ${opts.id} is not claimable`);
    return;
  }
  const lease = (await leaseRes.json()) as TaskLeaseResponse;
  if (lease.task_id !== opts.id) {
    await (opts.fetch ?? fetch)(
      buildDaemonUrl(opts.fetch, daemon, `/tasks/${lease.task_id}/cancel`),
      {
        method: "POST",
        headers: {
          ...(daemon ? { authorization: `Bearer ${daemon.token}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: `claimed by review flow for ${opts.id}` }),
      },
    );
    print(`task ${opts.id} is not claimable`);
    return;
  }
  const taskRes = await (opts.fetch ?? fetch)(
    buildDaemonUrl(opts.fetch, daemon, `/tasks/${opts.id}?include=lease,events`),
    {
      headers: daemon ? { authorization: `Bearer ${daemon.token}` } : undefined,
    },
  );
  const task = (await taskRes.json()) as TaskShowResponse;
  const editor = opts.editor ?? process.env.EDITOR ?? "vi";
  const dir = mkdtempSync(join(tmpdir(), "penumbra-task-review-"));
  const tmpPath = join(dir, "review.yaml");
  try {
    const scaffold = [
      `prompt: ${JSON.stringify(task.prompt)}`,
      `acceptance_criteria: ${JSON.stringify(task.acceptance_criteria)}`,
      "passed: true",
      "notes: |",
      "  ",
    ].join("\n");
    await Bun.write(tmpPath, scaffold);
    const proc = Bun.spawn({
      cmd: [editor, tmpPath],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    const parsed = YAML.parse(await Bun.file(tmpPath).text()) as {
      passed?: boolean;
      notes?: string;
    };
    if (parsed.passed !== true || typeof parsed.notes !== "string") {
      throw new Error("penumbra task review: editor file must contain passed: true and notes");
    }
    const completeRes = await (opts.fetch ?? fetch)(
      buildDaemonUrl(opts.fetch, daemon, `/tasks/${opts.id}/complete`),
      {
        method: "POST",
        headers: {
          ...(daemon ? { authorization: `Bearer ${daemon.token}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          lease_id: lease.lease_id,
          result_summary: "review completed",
          review_verdict: { passed: parsed.passed, notes: parsed.notes },
        }),
      },
    );
    if (!completeRes.ok)
      throw new Error(
        `penumbra task review: daemon /tasks/${opts.id}/complete returned HTTP ${String(completeRes.status)}`,
      );
    print(`reviewed ${opts.id}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runTaskWatch(opts: RunTaskWatchOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const res = await (opts.fetch ?? fetch)(buildDaemonUrl(opts.fetch, daemon, "/tasks/events"), {
    headers: daemon ? { authorization: `Bearer ${daemon.token}` } : undefined,
  });
  if (!res.ok || !res.body)
    throw new Error(
      `penumbra task watch: daemon /tasks/events returned HTTP ${String(res.status)}`,
    );
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const part = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(6)) as TaskWatchEvent;
      print(formatTaskWatchEvent(event));
    }
  }
}

interface TaskWatchEvent {
  kind: string;
  task_id: string;
  actor: string | null;
  ts: string;
  agent?: string;
  chain_handoff_id?: string;
  pct?: number;
  reason?: string;
}

function formatTaskWatchEvent(event: TaskWatchEvent): string {
  if (event.kind === "orchestrate_spawned") {
    return `[${event.ts}] orchestrate-spawned task=${event.task_id} agent=${event.agent ?? ""} chain=${(event.chain_handoff_id ?? "").slice(0, 8)}`;
  }
  if (event.kind === "orchestrate_warning") {
    return `[${event.ts}] orchestrate-warning task=${event.task_id} pct=${String(event.pct ?? 0)}%`;
  }
  if (event.kind === "orchestrate_terminated") {
    return `[${event.ts}] orchestrate-terminated task=${event.task_id} reason=${event.reason ?? ""}`;
  }
  return `[${event.ts}] ${event.kind} task=${event.task_id} actor=${event.actor ?? "-"}`;
}
