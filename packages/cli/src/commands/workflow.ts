import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDaemonStorageRoot } from "@penumbra/core";

function resolveDaemon(storageRoot?: string): { baseUrl: string; token: string } {
  const root = storageRoot ?? resolveDaemonStorageRoot();
  const port = readFileSync(join(root, "port"), "utf8").trim();
  const token = readFileSync(join(root, "token"), "utf8").trim();
  if (!port || Number.isNaN(Number(port))) {
    throw new Error(`penumbra workflow: invalid daemon port in ${join(root, "port")}`);
  }
  if (!token) {
    throw new Error(`penumbra workflow: empty daemon token in ${join(root, "token")}`);
  }
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

async function daemonGet(path: string, storageRoot: string): Promise<unknown> {
  const d = resolveDaemon(storageRoot);
  const r = await fetch(`${d.baseUrl}${path}`, { headers: { authorization: `Bearer ${d.token}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function daemonPost(path: string, body: unknown, storageRoot: string): Promise<unknown> {
  const d = resolveDaemon(storageRoot);
  const r = await fetch(`${d.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export type WorkflowSummary = { name: string; description: string; triggers: unknown[] };
export type ListFetcher = () => Promise<{ workflows: WorkflowSummary[] }>;

export async function runWorkflowList(opts: {
  out: (s: string) => void;
  fetchList: ListFetcher;
  showTriggers?: boolean;
}): Promise<void> {
  const { workflows } = await opts.fetchList();
  if (workflows.length === 0) {
    opts.out("(no workflows registered)");
    return;
  }
  for (const w of workflows) {
    opts.out(`${w.name}\t${w.description}`);
    if (opts.showTriggers) {
      for (const t of w.triggers) opts.out(`  trigger: ${JSON.stringify(t)}`);
    }
  }
}

export async function runWorkflowRun(opts: {
  out: (s: string) => void;
  storageRoot: string;
  name: string;
  dryRun?: boolean;
  sessionId?: string;
  post?: (path: string, body: unknown, storageRoot: string) => Promise<unknown>;
}): Promise<void> {
  if (opts.dryRun) {
    opts.out(`(dry-run) would run ${opts.name}`);
    return;
  }
  const body: { name: string; session_id?: string } = { name: opts.name };
  if (opts.sessionId) body.session_id = opts.sessionId;
  const post = opts.post ?? daemonPost;
  const result = await post("/workflows/run", body, opts.storageRoot);
  opts.out(JSON.stringify(result, null, 2));
}

export async function runWorkflowHistory(opts: {
  out: (s: string) => void;
  storageRoot: string;
  name: string;
}): Promise<void> {
  const result = await daemonGet(
    `/workflows/history?name=${encodeURIComponent(opts.name)}`,
    opts.storageRoot,
  );
  opts.out(JSON.stringify(result, null, 2));
}

export async function runWorkflowSuggest(opts: {
  out: (s: string) => void;
  storageRoot: string;
}): Promise<void> {
  const result = await daemonPost("/workflows/suggest", {}, opts.storageRoot);
  opts.out(JSON.stringify(result, null, 2));
}

export async function dispatchWorkflowSubcommand(
  args: string[],
  storageRoot: string,
): Promise<number> {
  const sub = args[0];
  const out = (s: string) => process.stdout.write(`${s}\n`);
  switch (sub) {
    case "list": {
      const showTriggers = args.includes("--triggers");
      await runWorkflowList({
        out,
        fetchList: () =>
          daemonGet("/workflows/list", storageRoot) as Promise<{ workflows: WorkflowSummary[] }>,
        showTriggers,
      });
      return 0;
    }
    case "run": {
      const name = args[1];
      if (!name || name.startsWith("-")) {
        console.error("usage: penumbra workflow run <name> [--dry-run] [--session-id <id>]");
        return 2;
      }
      const sidIdx = args.indexOf("--session-id");
      const sessionId = sidIdx >= 0 ? args[sidIdx + 1] : undefined;
      await runWorkflowRun({
        out,
        storageRoot,
        name,
        dryRun: args.includes("--dry-run"),
        sessionId,
      });
      return 0;
    }
    case "history": {
      const name = args[1];
      if (!name || name.startsWith("-")) {
        console.error("usage: penumbra workflow history <name>");
        return 2;
      }
      await runWorkflowHistory({ out, storageRoot, name });
      return 0;
    }
    case "suggest":
      await runWorkflowSuggest({ out, storageRoot });
      return 0;
    default:
      console.error("usage: penumbra workflow <list|run|history|suggest>");
      return 2;
  }
}
