import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface TaskRecord {
  id: string;
  kind: string;
  status: string;
  eligibility: { allow_agents?: string[] };
  chain_id: string | null;
}

interface TaskListResponse {
  tasks: TaskRecord[];
}

interface MaestroSessionResponse {
  task_id: string;
  agent_id: string;
  started_at: number;
  consumed_wall_clock_ms: number;
  wall_clock_budget_ms: number;
  consumed_cost_cents: number;
  cost_budget_cents: number;
  consumed_sub_dispatches: number;
  sub_dispatch_budget: number;
}

export interface RunMaestroListOpts {
  json: boolean;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

function defaultPrint(line: string): void {
  process.stdout.write(`${line}\n`);
}

function resolveDaemon(storageRoot: string): { baseUrl: string; token: string } {
  const port = Number(readFileSync(join(storageRoot, 'port'), 'utf8').trim());
  const token = readFileSync(join(storageRoot, 'token'), 'utf8').trim();
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

function pct(consumed: number, budget: number): string {
  return budget > 0 ? `${Math.round((consumed / budget) * 100)}` : '—';
}

export async function runMaestroList(opts: RunMaestroListOpts): Promise<void> {
  const print = opts.print ?? defaultPrint;
  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const listRes = await (opts.fetch ?? fetch)(opts.fetch ? '/tasks?kind=orchestrate' : `${daemon!.baseUrl}/tasks?kind=orchestrate`, {
    headers: daemon ? { authorization: `Bearer ${daemon.token}` } : undefined,
  });
  if (!listRes.ok) throw new Error(`penumbra maestro list: daemon /tasks returned HTTP ${listRes.status}`);
  const body = await listRes.json() as TaskListResponse;

  const rows: Array<{ id: string; agent: string; status: string; wall_clock_pct: string; cost_pct: string; sub_dispatch_pct: string }> = [];
  for (const task of body.tasks) {
    let wall = '—';
    let cost = '—';
    let sub = '—';
    const session = await fetchSession(task.id, opts.fetch, daemon);
    if (session) {
      wall = pct(session.consumed_wall_clock_ms, session.wall_clock_budget_ms);
      cost = pct(session.consumed_cost_cents, session.cost_budget_cents);
      sub = pct(session.consumed_sub_dispatches, session.sub_dispatch_budget);
      rows.push({ id: task.id.slice(0, 8), agent: session.agent_id, status: task.status, wall_clock_pct: wall, cost_pct: cost, sub_dispatch_pct: sub });
      continue;
    }
    rows.push({ id: task.id.slice(0, 8), agent: task.eligibility.allow_agents?.[0] ?? '—', status: task.status, wall_clock_pct: wall, cost_pct: cost, sub_dispatch_pct: sub });
  }

  if (opts.json) {
    print(JSON.stringify({ tasks: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    print('(no orchestrate tasks)');
    return;
  }
  print(['id', 'agent', 'status', 'wall_clock_pct', 'cost_pct', 'sub_dispatch_pct'].join('  '));
  for (const row of rows) {
    print([row.id, row.agent, row.status, row.wall_clock_pct, row.cost_pct, row.sub_dispatch_pct].join('  '));
  }
}

async function fetchSession(id: string, localFetch: typeof fetch | undefined, daemon: { baseUrl: string; token: string } | null): Promise<MaestroSessionResponse | null> {
  try {
    const res = await (localFetch ?? fetch)(localFetch ? `/maestro/sessions/${id}` : `${daemon!.baseUrl}/maestro/sessions/${id}`, {
      headers: daemon ? { authorization: `Bearer ${daemon.token}` } : undefined,
    });
    if (!res.ok) return null;
    return await res.json() as MaestroSessionResponse;
  } catch {
    return null;
  }
}
