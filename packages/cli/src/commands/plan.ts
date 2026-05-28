import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { defaultProjectRegistryPath, loadProjectRegistry } from "@penumbra/core";
import { parsePlanMetaFile, validatePlan } from "@penumbra/workflows";
import { renderPlanTree } from "./plan-render.js";

const FALLBACK_AGENTS: string[] = [
  "codex-acp-fast",
  "claude-acp-sonnet",
  "claude-acp-haiku",
  "gemini-acp",
  "opencode-acp",
];

/** Sentinels accepted in addition to whatever the registry returns. `maestro-inline`
 * marks tasks the maestro performs directly (smoke tests, research probes) — they
 * have no real agent backing them. */
const MAESTRO_SENTINELS: string[] = ["maestro-inline"];

export type Out = (s: string) => void;

export function findRepoRoot(startPath: string): string {
  const absolute = isAbsolute(startPath) ? startPath : resolve(process.cwd(), startPath);
  let current = existsSync(absolute) ? absolute : dirname(absolute);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

async function loadFromDaemon(storageRoot: string): Promise<Set<string> | null> {
  try {
    const port = (await readFile(join(storageRoot, "port"), "utf8")).trim();
    const token = (await readFile(join(storageRoot, "token"), "utf8")).trim();
    if (!port || !token) return null;
    const r = await fetch(`http://127.0.0.1:${port}/chains/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { agents?: Array<{ name?: unknown }> };
    const names = (body.agents ?? [])
      .map((a) => (typeof a?.name === "string" ? a.name : null))
      .filter((n): n is string => n != null && n.length > 0);
    return names.length > 0 ? new Set(names) : null;
  } catch {
    return null;
  }
}

async function loadFromYaml(repoRoot: string, warn: Out): Promise<Set<string> | null> {
  const yamlPath = join(repoRoot, "agentchat.yaml");
  if (!existsSync(yamlPath)) return null;
  try {
    const text = await readFile(yamlPath, "utf8");
    const parsed = YAML.parse(text) as { agents?: Array<{ name?: unknown }> } | undefined;
    const names = (parsed?.agents ?? [])
      .map((a) => (typeof a?.name === "string" ? a.name : null))
      .filter((n): n is string => n != null && n.length > 0);
    return names.length > 0 ? new Set(names) : null;
  } catch (err) {
    warn(
      `plan validate: failed to read agentchat.yaml (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

export async function loadKnownAgents(
  repoRoot: string,
  warn: Out,
  storageRoot?: string,
): Promise<Set<string>> {
  let base: Set<string> | null = null;
  if (storageRoot) {
    base = await loadFromDaemon(storageRoot);
  }
  if (!base) base = await loadFromYaml(repoRoot, warn);
  if (!base) base = new Set(FALLBACK_AGENTS);
  for (const sentinel of MAESTRO_SENTINELS) base.add(sentinel);
  return base;
}

export interface RunPlanValidateOpts {
  path: string;
  repoRoot?: string;
  knownAgents?: Set<string>;
  projectRegistry?: { has(project_id: string): boolean };
  header?: { home_project?: string };
  storageRoot?: string;
  noRegistry?: boolean;
  out: Out;
  err: Out;
}

export async function runPlanValidate(opts: RunPlanValidateOpts): Promise<number> {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.path);
  const knownAgents =
    opts.knownAgents ?? (await loadKnownAgents(repoRoot, opts.err, opts.storageRoot));
  const { header, tasks, errors } = await parsePlanMetaFile(opts.path);
  const projectRegistry =
    opts.noRegistry === true
      ? undefined
      : (opts.projectRegistry ??
        loadProjectRegistry(process.env.PENUMBRA_PROJECTS_YAML ?? defaultProjectRegistryPath()));

  let hasIssue = false;

  if (errors.length > 0) {
    hasIssue = true;
    for (const e of errors) {
      opts.err(`parse: ${opts.path}: line ${e.line}: ${e.reason}`);
    }
  }

  if (tasks.length === 0 && errors.length === 0) {
    opts.err(`validate: no yaml meta blocks found in ${opts.path}`);
    return 2;
  }

  const validationErrors = await validatePlan(tasks, {
    repoRoot,
    knownAgents,
    projectRegistry,
    header: header ? { home_project: header.home_project } : undefined,
  });
  if (validationErrors.length > 0) {
    hasIssue = true;
    for (const e of validationErrors) {
      opts.err(`${e.task_id}: ${e.rule}: ${e.message}`);
    }
  }

  if (hasIssue) return 2;
  return 0;
}

interface PlanRecord {
  plan_id: string;
  file_path: string;
  home_project: string;
  registered_at: number;
  status: string;
}

interface PlanTaskRecord {
  plan_id: string;
  task_meta_id: string;
  project_id: string;
  task_id_in_board: string | null;
  status: string;
  last_event_ts: number | null;
}

interface PlanStartResponse {
  plan_id: string;
  status: string;
}

interface PlanListResponse {
  plans: PlanRecord[];
}

interface PlanGetResponse {
  plan: PlanRecord;
  tasks: PlanTaskRecord[];
}

interface PlanCancelResponse {
  plan_id: string;
  status: string;
  cancelled_running_count: number;
}

export interface RunPlanStartOpts {
  path: string;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: Out;
}

export interface RunPlanListOpts {
  status?: string;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: Out;
}

export interface RunPlanStatusOpts {
  id: string;
  watch?: boolean;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: Out;
}

export interface RunPlanCancelOpts {
  id: string;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: Out;
}

function defaultPrint(line: string): void {
  console.log(line);
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const port = Number(readFileSync(join(storageRoot, "port"), "utf8").trim());
  const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`penumbra plan: invalid daemon port in ${join(storageRoot, "port")}`);
  }
  if (!token) {
    throw new Error(`penumbra plan: empty daemon token in ${join(storageRoot, "token")}`);
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

function requestHeaders(
  token: string | null,
  headers?: RequestInit["headers"],
): RequestInit["headers"] {
  if (!token) return headers;
  const merged = new Headers(headers ?? undefined);
  merged.set("authorization", `Bearer ${token}`);
  return merged;
}

function daemonRequest(
  opts: { storageRoot: string; fetch?: typeof fetch },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  return (opts.fetch ?? fetch)(opts.fetch ? path : `${daemon!.baseUrl}${path}`, {
    ...init,
    headers: requestHeaders(daemon?.token ?? null, init?.headers),
  });
}

async function daemonError(action: string, path: string, res: Response): Promise<never> {
  let detail = "";
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown; details?: unknown };
        if (typeof parsed.error === "string") {
          detail = parsed.error;
        } else {
          detail = text;
        }
      } catch {
        detail = text;
      }
    }
  } catch {
    detail = "";
  }
  throw new Error(
    `penumbra plan ${action}: daemon ${path} returned HTTP ${res.status}${detail ? ` (${detail})` : ""}`,
  );
}

function normalizeTaskRef(ref: string): string {
  const idx = ref.lastIndexOf("/");
  return idx >= 0 ? ref.slice(idx + 1) : ref;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function renderTaskForest<T extends { id: string; depends_on: string[] }>(
  tasks: T[],
  renderLine: (task: T) => string,
  out: Out,
): void {
  if (tasks.length === 0) {
    return;
  }

  const indexById = new Map(tasks.map((task, index) => [task.id, index] as const));
  const childrenByParent = new Map<string, string[]>();
  const roots: string[] = [];

  for (const task of tasks) {
    const deps = unique(
      task.depends_on.map(normalizeTaskRef).filter((dep) => dep !== task.id && indexById.has(dep)),
    );
    if (deps.length === 0) {
      roots.push(task.id);
      continue;
    }
    const parent = deps[0]!;
    const children = childrenByParent.get(parent);
    if (children) {
      children.push(task.id);
    } else {
      childrenByParent.set(parent, [task.id]);
    }
  }

  for (const children of childrenByParent.values()) {
    children.sort((a, b) => indexById.get(a)! - indexById.get(b)!);
  }
  roots.sort((a, b) => indexById.get(a)! - indexById.get(b)!);

  const visited = new Set<string>();
  const emit = (taskId: string, depth: number): void => {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    const task = tasks[indexById.get(taskId)!]!;
    out(`${"  ".repeat(depth)}${renderLine(task)}`);
    for (const child of childrenByParent.get(taskId) ?? []) {
      emit(child, depth + 1);
    }
  };

  for (const root of roots) emit(root, 0);
  for (const task of tasks) {
    if (!visited.has(task.id)) emit(task.id, 0);
  }
}

function formatStatusCounts(tasks: PlanTaskRecord[]): string {
  const counts = {
    running: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) {
    if (task.status in counts) {
      counts[task.status as keyof typeof counts] += 1;
    }
  }
  return `running=${counts.running} pending=${counts.pending} completed=${counts.completed} failed=${counts.failed} cancelled=${counts.cancelled}`;
}

function formatIso(ts: number): string {
  return new Date(ts).toISOString();
}

async function fetchPlanStartMeta(path: string): Promise<{
  header?: { home_project?: string };
  tasks: Array<{ id: string; project?: string; depends_on: string[] }>;
}> {
  const { header, tasks } = await parsePlanMetaFile(path);
  return {
    header: header ? { home_project: header.home_project } : undefined,
    tasks: tasks.map((task) => ({
      id: task.id,
      project: task.project,
      depends_on: task.depends_on,
    })),
  };
}

async function renderPlanTasks(
  tasks: Array<{
    id: string;
    project_id: string;
    status: string;
    depends_on: string[];
    task_id_in_board?: string | null;
  }>,
  out: Out,
  opts: { includeBoard: boolean },
): Promise<void> {
  renderTaskForest(
    tasks,
    (task) => {
      const base = `[${task.status}] ${task.id} · project=${task.project_id}`;
      return opts.includeBoard ? `${base} · board=${task.task_id_in_board ?? "-"}` : base;
    },
    out,
  );
}

export async function runPlanStart(opts: RunPlanStartOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const meta = await fetchPlanStartMeta(opts.path);
  const res = await daemonRequest(opts, "/plans", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ file_path: resolve(opts.path) }),
  });
  if (!res.ok) await daemonError("start", "/plans", res);
  const body = (await res.json()) as PlanStartResponse;
  print(`plan_id: ${body.plan_id}`);
  if (meta.tasks.length === 0) {
    print("(no tasks)");
    return;
  }
  await renderPlanTasks(
    meta.tasks.map((task) => ({
      id: task.id,
      project_id: task.project ?? meta.header?.home_project ?? "-",
      status: "pending",
      depends_on: task.depends_on,
    })),
    print,
    { includeBoard: false },
  );
}

export async function runPlanList(opts: RunPlanListOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await daemonRequest(opts, `/plans${suffix}`);
  if (!res.ok) await daemonError("list", "/plans", res);
  const body = (await res.json()) as PlanListResponse;
  if (body.plans.length === 0) {
    print("(no plans)");
    return;
  }

  const rows: Array<{
    plan_id: string;
    home_project: string;
    status: string;
    registered_at: string;
    tasks: string;
  }> = [];

  for (const plan of body.plans) {
    const detailRes = await daemonRequest(opts, `/plans/${plan.plan_id}`);
    if (!detailRes.ok) await daemonError("list", `/plans/${plan.plan_id}`, detailRes);
    const detail = (await detailRes.json()) as PlanGetResponse;
    rows.push({
      plan_id: plan.plan_id.slice(0, 12),
      home_project: plan.home_project,
      status: plan.status,
      registered_at: formatIso(plan.registered_at),
      tasks: formatStatusCounts(detail.tasks),
    });
  }

  const homeWidth = Math.max("home_project".length, ...rows.map((row) => row.home_project.length));
  const statusWidth = Math.max("status".length, ...rows.map((row) => row.status.length));
  const registeredWidth = Math.max(
    "registered_at".length,
    ...rows.map((row) => row.registered_at.length),
  );
  const tasksWidth = Math.max("tasks".length, ...rows.map((row) => row.tasks.length));

  print(
    [
      "plan_id".padEnd(12),
      "home_project".padEnd(homeWidth),
      "status".padEnd(statusWidth),
      "registered_at".padEnd(registeredWidth),
      "tasks".padEnd(tasksWidth),
    ].join("  "),
  );
  for (const row of rows) {
    print(
      [
        row.plan_id.padEnd(12),
        row.home_project.padEnd(homeWidth),
        row.status.padEnd(statusWidth),
        row.registered_at.padEnd(registeredWidth),
        row.tasks.padEnd(tasksWidth),
      ].join("  "),
    );
  }
}

async function loadPlanTreeNodes(
  plan: PlanRecord,
  tasks: PlanTaskRecord[],
): Promise<
  Array<{
    id: string;
    project_id: string;
    status: string;
    depends_on: string[];
    task_id_in_board: string | null;
  }>
> {
  try {
    const meta = await parsePlanMetaFile(plan.file_path);
    const runtimeById = new Map(tasks.map((task) => [task.task_meta_id, task] as const));
    const nodes = meta.tasks.map((task) => {
      const runtime = runtimeById.get(task.id);
      return {
        id: task.id,
        project_id: runtime?.project_id ?? task.project ?? plan.home_project,
        status: runtime?.status ?? "pending",
        depends_on: task.depends_on,
        task_id_in_board: runtime?.task_id_in_board ?? null,
      };
    });
    const knownIds = new Set(nodes.map((node) => node.id));
    for (const task of tasks) {
      if (knownIds.has(task.task_meta_id)) continue;
      nodes.push({
        id: task.task_meta_id,
        project_id: task.project_id,
        status: task.status,
        depends_on: [],
        task_id_in_board: task.task_id_in_board,
      });
    }
    return nodes;
  } catch {
    return tasks.map((task) => ({
      id: task.task_meta_id,
      project_id: task.project_id,
      status: task.status,
      depends_on: [],
      task_id_in_board: task.task_id_in_board,
    }));
  }
}

async function renderPlanStatusOnce(opts: RunPlanStatusOpts, out: Out): Promise<void> {
  const res = await daemonRequest(opts, `/plans/${opts.id}`);
  if (!res.ok) await daemonError("status", `/plans/${opts.id}`, res);
  const body = (await res.json()) as PlanGetResponse;
  const nodes = await loadPlanTreeNodes(body.plan, body.tasks);
  out(
    renderPlanTree({
      plan: body.plan,
      tasks: nodes.map((task) => ({
        task_meta_id: task.id,
        project_id: task.project_id,
        task_id_in_board: task.task_id_in_board,
        status: task.status,
      })),
    }),
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runPlanStatus(opts: RunPlanStatusOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const interval = opts.pollIntervalMs ?? 2_000;
  const shouldClear = opts.print == null && process.stdout.isTTY === true;
  let first = true;

  while (true) {
    if (!first && shouldClear) {
      print("\u001b[2J\u001b[H");
    }
    await renderPlanStatusOnce(opts, print);
    if (!opts.watch) return;
    if (opts.signal?.aborted) return;
    await sleep(interval, opts.signal);
    if (opts.signal?.aborted) return;
    first = false;
  }
}

export async function runPlanCancel(opts: RunPlanCancelOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const res = await daemonRequest(opts, `/plans/${opts.id}/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
  });
  if (!res.ok) await daemonError("cancel", `/plans/${opts.id}/cancel`, res);
  const body = (await res.json()) as PlanCancelResponse;
  print(`cancelled ${body.cancelled_running_count}`);
}

export async function dispatchPlanSubcommand(args: string[], storageRoot: string): Promise<number> {
  const sub = args[0];
  const out = (s: string) => console.log(s);
  const err = (s: string) => console.error(s);
  switch (sub) {
    case "start": {
      const path = args[1];
      if (!path || path.startsWith("-")) {
        err("usage: penumbra plan start <path>");
        return 2;
      }
      await runPlanStart({ path, storageRoot, print: out });
      return 0;
    }
    case "list": {
      const statusIdx = args.indexOf("--status");
      const status = statusIdx >= 0 ? (args[statusIdx + 1] ?? undefined) : undefined;
      if (statusIdx >= 0 && (!status || status.startsWith("-"))) {
        err("usage: penumbra plan list [--status <status>]");
        return 2;
      }
      await runPlanList({ status, storageRoot, print: out });
      return 0;
    }
    case "status":
    case "watch": {
      const id = args[1];
      const watch = sub === "watch" || args.includes("--watch");
      if (!id || id.startsWith("-")) {
        err(
          watch
            ? "usage: penumbra plan watch <plan_id>"
            : "usage: penumbra plan status <plan_id> [--watch]",
        );
        return 2;
      }
      await runPlanStatus({ id, watch, storageRoot, print: out });
      return 0;
    }
    case "cancel": {
      const id = args[1];
      if (!id || id.startsWith("-")) {
        err("usage: penumbra plan cancel <plan_id>");
        return 2;
      }
      await runPlanCancel({ id, storageRoot, print: out });
      return 0;
    }
    case "validate": {
      const path = args[1];
      const noRegistry = args.includes("--no-registry");
      if (!path || path.startsWith("-")) {
        err("usage: penumbra plan validate <path>");
        return 2;
      }
      return runPlanValidate({ path, storageRoot, noRegistry, out, err });
    }
    default:
      err("usage: penumbra plan <start|list|status|cancel|watch|validate>");
      return 2;
  }
}
