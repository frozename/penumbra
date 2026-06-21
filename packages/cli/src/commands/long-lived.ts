import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunLongLivedOpts {
  json: boolean;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

export interface RunLongLivedIdOpts extends RunLongLivedOpts {
  id: string;
}

export interface RunLongLivedActionOpts extends RunLongLivedIdOpts {
  reason?: string;
}

export interface RunLongLivedStateSetOpts extends RunLongLivedIdOpts {
  intent_summary?: string;
  working_memory?: object;
}

export interface RunLongLivedInjectOpts extends RunLongLivedIdOpts {
  goal: string;
}

export interface RunLongLivedApproveOpts extends RunLongLivedOpts {
  action_id: string;
}

export interface RunLongLivedRejectOpts extends RunLongLivedApproveOpts {
  reason?: string;
}

function defaultPrint(line: string): void {
  process.stdout.write(`${line}\n`);
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const port = Number(readFileSync(join(storageRoot, "port"), "utf8").trim());
  const token = readFileSync(join(storageRoot, "token"), "utf8").trim();
  return { baseUrl: `http://127.0.0.1:${String(port)}`, token };
}

async function request(
  opts: { storageRoot: string; fetch?: typeof fetch },
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const localFetch = opts.fetch;
  const daemon = localFetch ? null : resolveDaemon(opts.storageRoot);
  const url = daemon === null ? path : `${daemon.baseUrl}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (daemon) headers.authorization = `Bearer ${daemon.token}`;
  const res = await (localFetch ?? fetch)(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok)
    throw new Error(`penumbra long-lived: HTTP ${String(res.status)}: ${await res.text()}`);
  if (res.status === 204) return null;
  return await res.json();
}

function printJson(opts: { json: boolean; print?: (line: string) => void }, body: unknown): void {
  const print = opts.print ?? defaultPrint;
  print(JSON.stringify(body, null, 2));
}

export async function runLongLivedList(opts: RunLongLivedOpts): Promise<void> {
  const body = await request(
    { storageRoot: opts.storageRoot, fetch: opts.fetch },
    "GET",
    "/long-lived",
  );
  printJson(opts, body);
}

export async function runLongLivedGet(opts: RunLongLivedIdOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "GET",
      `/long-lived/${encodeURIComponent(opts.id)}`,
    ),
  );
}

export async function runLongLivedPause(opts: RunLongLivedActionOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/${encodeURIComponent(opts.id)}/pause`,
    ),
  );
}

export async function runLongLivedResume(opts: RunLongLivedActionOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/${encodeURIComponent(opts.id)}/resume`,
    ),
  );
}

export async function runLongLivedRetire(opts: RunLongLivedActionOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/${encodeURIComponent(opts.id)}/retire`,
    ),
  );
}

export async function runLongLivedStateGet(opts: RunLongLivedIdOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "GET",
      `/long-lived/${encodeURIComponent(opts.id)}/state`,
    ),
  );
}

export async function runLongLivedStateSet(opts: RunLongLivedStateSetOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/${encodeURIComponent(opts.id)}/state`,
      {
        intent_summary: opts.intent_summary,
        working_memory: opts.working_memory,
      },
    ),
  );
}

export async function runLongLivedPending(opts: RunLongLivedIdOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "GET",
      `/long-lived/${encodeURIComponent(opts.id)}/pending-actions?status=pending`,
    ),
  );
}

export async function runLongLivedApprove(opts: RunLongLivedApproveOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/pending-actions/${encodeURIComponent(opts.action_id)}/approve`,
    ),
  );
}

export async function runLongLivedReject(opts: RunLongLivedRejectOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/pending-actions/${encodeURIComponent(opts.action_id)}/reject`,
      { reason: opts.reason },
    ),
  );
}

export async function runLongLivedInject(opts: RunLongLivedInjectOpts): Promise<void> {
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/${encodeURIComponent(opts.id)}/inject-goal`,
      { goal: opts.goal },
    ),
  );
}

export async function runLongLivedAudit(
  opts: RunLongLivedIdOpts & { since?: string; limit?: string },
): Promise<void> {
  const query = new URLSearchParams();
  if (opts.since) query.set("since", opts.since);
  if (opts.limit) query.set("limit", opts.limit);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "GET",
      `/long-lived/${encodeURIComponent(opts.id)}/audit${suffix}`,
    ),
  );
}

export async function runLongLivedTicks(
  opts: RunLongLivedIdOpts & { since?: string; limit?: string },
): Promise<void> {
  const query = new URLSearchParams();
  if (opts.since) query.set("since", opts.since);
  if (opts.limit) query.set("limit", opts.limit);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "GET",
      `/long-lived/${encodeURIComponent(opts.id)}/ticks${suffix}`,
    ),
  );
}

type IdRunner = (opts: { json: boolean; storageRoot: string; id: string }) => Promise<void>;

async function runIdCommand(
  args: string[],
  storageRoot: string,
  usage: string,
  runner: IdRunner,
): Promise<number> {
  const id = args[1];
  if (!id || id.startsWith("-")) return invalidUsage(usage);
  await runner({ json: args.includes("--json"), storageRoot, id });
  return 0;
}

async function runStateCommand(args: string[], storageRoot: string): Promise<number> {
  const usage =
    "penumbra long-lived state <get|set> <id> [--intent-summary <text>] [--working-memory <json>] [--json]";
  const action = args[1];
  const id = args[2];
  if (!id || id.startsWith("-")) return invalidUsage(usage);
  if (action === "get") {
    await runLongLivedStateGet({ json: args.includes("--json"), storageRoot, id });
    return 0;
  }
  if (action !== "set") return invalidUsage(usage);
  const intentSummary = readArgValue(args, "--intent-summary");
  const workingMemoryRaw = readArgValue(args, "--working-memory");
  let workingMemory: object | undefined;
  if (workingMemoryRaw !== undefined) {
    try {
      workingMemory = JSON.parse(workingMemoryRaw) as object;
    } catch {
      return invalidUsage("penumbra long-lived state set: --working-memory must be valid JSON");
    }
  }
  await runLongLivedStateSet({
    json: args.includes("--json"),
    storageRoot,
    id,
    intent_summary: intentSummary,
    working_memory: workingMemory,
  });
  return 0;
}

async function runApproveCommand(args: string[], storageRoot: string): Promise<number> {
  const actionId = args[1];
  if (!actionId || actionId.startsWith("-"))
    return invalidUsage("penumbra long-lived approve <action_id> [--json]");
  await runLongLivedApprove({
    json: args.includes("--json"),
    storageRoot,
    action_id: actionId,
  });
  return 0;
}

async function runRejectCommand(args: string[], storageRoot: string): Promise<number> {
  const actionId = args[1];
  if (!actionId || actionId.startsWith("-"))
    return invalidUsage("penumbra long-lived reject <action_id> [--reason <text>] [--json]");
  await runLongLivedReject({
    json: args.includes("--json"),
    storageRoot,
    action_id: actionId,
    reason: readArgValue(args, "--reason") ?? undefined,
  });
  return 0;
}

async function runInjectGoalCommand(args: string[], storageRoot: string): Promise<number> {
  const usage = "penumbra long-lived inject-goal <id> --goal <text> [--json]";
  const id = args[1];
  if (!id || id.startsWith("-")) return invalidUsage(usage);
  const goal = readArgValue(args, "--goal");
  if (!goal) return invalidUsage(usage);
  await runLongLivedInject({ json: args.includes("--json"), storageRoot, id, goal });
  return 0;
}

async function runHistoryCommand(
  args: string[],
  storageRoot: string,
  usage: string,
  runner: (opts: {
    json: boolean;
    storageRoot: string;
    id: string;
    since?: string;
    limit?: string;
  }) => Promise<void>,
): Promise<number> {
  const id = args[1];
  if (!id || id.startsWith("-")) return invalidUsage(usage);
  await runner({
    json: args.includes("--json"),
    storageRoot,
    id,
    since: readArgValue(args, "--since") ?? undefined,
    limit: readArgValue(args, "--limit") ?? undefined,
  });
  return 0;
}

export async function dispatchLongLivedSubcommand(
  args: string[],
  storageRoot: string,
): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case undefined:
      return invalidUsage(
        "penumbra long-lived <list|get|pause|resume|retire|state|pending-actions|approve|reject|inject-goal|audit|ticks>",
      );
    case "list":
      await runLongLivedList({ json: args.includes("--json"), storageRoot });
      return 0;
    case "get":
      return await runIdCommand(
        args,
        storageRoot,
        "penumbra long-lived get <id> [--json]",
        runLongLivedGet,
      );
    case "pause":
      return await runIdCommand(
        args,
        storageRoot,
        "penumbra long-lived pause <id> [--json]",
        runLongLivedPause,
      );
    case "resume":
      return await runIdCommand(
        args,
        storageRoot,
        "penumbra long-lived resume <id> [--json]",
        runLongLivedResume,
      );
    case "retire":
      return await runIdCommand(
        args,
        storageRoot,
        "penumbra long-lived retire <id> [--json]",
        runLongLivedRetire,
      );
    case "state":
      return await runStateCommand(args, storageRoot);
    case "pending-actions":
      return await runIdCommand(
        args,
        storageRoot,
        "penumbra long-lived pending-actions <id> [--json]",
        runLongLivedPending,
      );
    case "approve":
      return await runApproveCommand(args, storageRoot);
    case "reject":
      return await runRejectCommand(args, storageRoot);
    case "inject-goal":
      return await runInjectGoalCommand(args, storageRoot);
    case "audit":
      return await runHistoryCommand(
        args,
        storageRoot,
        "penumbra long-lived audit <id> [--since <cursor>] [--limit <n>] [--json]",
        runLongLivedAudit,
      );
    case "ticks":
      return await runHistoryCommand(
        args,
        storageRoot,
        "penumbra long-lived ticks <id> [--since <cursor>] [--limit <n>] [--json]",
        runLongLivedTicks,
      );
    default:
      return invalidUsage(
        "penumbra long-lived <list|get|pause|resume|retire|state|pending-actions|approve|reject|inject-goal|audit|ticks>",
      );
  }
}

function readArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) return undefined;
  return value;
}

function invalidUsage(message: string): number {
  process.stderr.write(`usage: ${message}\n`);
  return 1;
}
