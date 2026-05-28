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
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

async function request(
  opts: { storageRoot: string; fetch?: typeof fetch },
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const localFetch = opts.fetch;
  const daemon = localFetch ? null : resolveDaemon(opts.storageRoot);
  const url = localFetch ? path : `${daemon!.baseUrl}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (daemon) headers.authorization = `Bearer ${daemon.token}`;
  const res = await (localFetch ?? fetch)(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`penumbra long-lived: HTTP ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return await res.json();
}

async function printJson(
  opts: { json: boolean; print?: (line: string) => void },
  body: unknown,
): Promise<void> {
  const print = opts.print ?? defaultPrint;
  print(JSON.stringify(body, null, 2));
}

export async function runLongLivedList(opts: RunLongLivedOpts): Promise<void> {
  const body = await request(
    { storageRoot: opts.storageRoot, fetch: opts.fetch },
    "GET",
    "/long-lived",
  );
  await printJson(opts, body);
}

export async function runLongLivedGet(opts: RunLongLivedIdOpts): Promise<void> {
  await printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "GET",
      `/long-lived/${encodeURIComponent(opts.id)}`,
    ),
  );
}

export async function runLongLivedPause(opts: RunLongLivedActionOpts): Promise<void> {
  await printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/${encodeURIComponent(opts.id)}/pause`,
    ),
  );
}

export async function runLongLivedResume(opts: RunLongLivedActionOpts): Promise<void> {
  await printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/${encodeURIComponent(opts.id)}/resume`,
    ),
  );
}

export async function runLongLivedRetire(opts: RunLongLivedActionOpts): Promise<void> {
  await printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/${encodeURIComponent(opts.id)}/retire`,
    ),
  );
}

export async function runLongLivedStateGet(opts: RunLongLivedIdOpts): Promise<void> {
  await printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "GET",
      `/long-lived/${encodeURIComponent(opts.id)}/state`,
    ),
  );
}

export async function runLongLivedStateSet(opts: RunLongLivedStateSetOpts): Promise<void> {
  await printJson(
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
  await printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "GET",
      `/long-lived/${encodeURIComponent(opts.id)}/pending-actions?status=pending`,
    ),
  );
}

export async function runLongLivedApprove(opts: RunLongLivedApproveOpts): Promise<void> {
  await printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "POST",
      `/long-lived/pending-actions/${encodeURIComponent(opts.action_id)}/approve`,
    ),
  );
}

export async function runLongLivedReject(opts: RunLongLivedRejectOpts): Promise<void> {
  await printJson(
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
  await printJson(
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
  await printJson(
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
  await printJson(
    opts,
    await request(
      { storageRoot: opts.storageRoot, fetch: opts.fetch },
      "GET",
      `/long-lived/${encodeURIComponent(opts.id)}/ticks${suffix}`,
    ),
  );
}

export async function dispatchLongLivedSubcommand(
  args: string[],
  storageRoot: string,
): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "list":
      await runLongLivedList({ json: args.includes("--json"), storageRoot });
      return 0;
    case "get": {
      const id = args[1];
      if (!id || id.startsWith("-")) return invalidUsage("penumbra long-lived get <id> [--json]");
      await runLongLivedGet({ json: args.includes("--json"), storageRoot, id });
      return 0;
    }
    case "pause": {
      const id = args[1];
      if (!id || id.startsWith("-")) return invalidUsage("penumbra long-lived pause <id> [--json]");
      await runLongLivedPause({ json: args.includes("--json"), storageRoot, id });
      return 0;
    }
    case "resume": {
      const id = args[1];
      if (!id || id.startsWith("-"))
        return invalidUsage("penumbra long-lived resume <id> [--json]");
      await runLongLivedResume({ json: args.includes("--json"), storageRoot, id });
      return 0;
    }
    case "retire": {
      const id = args[1];
      if (!id || id.startsWith("-"))
        return invalidUsage("penumbra long-lived retire <id> [--json]");
      await runLongLivedRetire({ json: args.includes("--json"), storageRoot, id });
      return 0;
    }
    case "state": {
      const action = args[1];
      const id = args[2];
      if (!id || id.startsWith("-"))
        return invalidUsage(
          "penumbra long-lived state <get|set> <id> [--intent-summary <text>] [--working-memory <json>] [--json]",
        );
      if (action === "get") {
        await runLongLivedStateGet({ json: args.includes("--json"), storageRoot, id });
        return 0;
      }
      if (action === "set") {
        const intentSummary = readArgValue(args, "--intent-summary");
        const workingMemoryRaw = readArgValue(args, "--working-memory");
        let workingMemory: object | undefined;
        if (workingMemoryRaw !== undefined) {
          try {
            workingMemory = JSON.parse(workingMemoryRaw) as object;
          } catch {
            return invalidUsage(
              "penumbra long-lived state set: --working-memory must be valid JSON",
            );
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
      return invalidUsage(
        "penumbra long-lived state <get|set> <id> [--intent-summary <text>] [--working-memory <json>] [--json]",
      );
    }
    case "pending-actions": {
      const id = args[1];
      if (!id || id.startsWith("-"))
        return invalidUsage("penumbra long-lived pending-actions <id> [--json]");
      await runLongLivedPending({ json: args.includes("--json"), storageRoot, id });
      return 0;
    }
    case "approve": {
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
    case "reject": {
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
    case "inject-goal": {
      const id = args[1];
      if (!id || id.startsWith("-"))
        return invalidUsage("penumbra long-lived inject-goal <id> --goal <text> [--json]");
      const goal = readArgValue(args, "--goal");
      if (!goal) return invalidUsage("penumbra long-lived inject-goal <id> --goal <text> [--json]");
      await runLongLivedInject({ json: args.includes("--json"), storageRoot, id, goal });
      return 0;
    }
    case "audit": {
      const id = args[1];
      if (!id || id.startsWith("-"))
        return invalidUsage(
          "penumbra long-lived audit <id> [--since <cursor>] [--limit <n>] [--json]",
        );
      await runLongLivedAudit({
        json: args.includes("--json"),
        storageRoot,
        id,
        since: readArgValue(args, "--since") ?? undefined,
        limit: readArgValue(args, "--limit") ?? undefined,
      });
      return 0;
    }
    case "ticks": {
      const id = args[1];
      if (!id || id.startsWith("-"))
        return invalidUsage(
          "penumbra long-lived ticks <id> [--since <cursor>] [--limit <n>] [--json]",
        );
      await runLongLivedTicks({
        json: args.includes("--json"),
        storageRoot,
        id,
        since: readArgValue(args, "--since") ?? undefined,
        limit: readArgValue(args, "--limit") ?? undefined,
      });
      return 0;
    }
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
  console.error(`usage: ${message}`);
  return 1;
}
