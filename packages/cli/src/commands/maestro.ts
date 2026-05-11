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
  chain_handoff_id: string | null;
  agent_id: string;
  started_at: number;
  wall_clock_budget_ms: number;
  cost_budget_cents: number;
  sub_dispatch_budget: number;
  cost_consumed_cents?: number | null;
  sub_dispatches_consumed?: number | null;
  consumed_wall_clock_ms?: number | null;
  soft_warned_at: number | null;
  terminated_at: number | null;
  termination_reason: string | null;
}

export interface RunMaestroListOpts {
  json: boolean;
  storageRoot: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}

export interface RunMaestroSessionGetOpts extends RunMaestroListOpts {
  task_id: string;
}

export interface RunMaestroSessionStartOpts extends RunMaestroListOpts {
  task_id: string;
  chain_handoff_id?: string;
  agent: string;
  wall_budget_ms: number;
  cost_budget_cents: number;
  sub_dispatch_budget: number;
}

export interface RunMaestroSessionStartAdhocOpts extends RunMaestroListOpts {
  message: string;
  agent: string;
  wall_budget_ms: number;
  cost_budget_cents: number;
  sub_dispatch_budget: number;
  project_id?: string;
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

async function request(opts: { storageRoot: string; fetch?: typeof fetch }, method: string, path: string, body?: unknown): Promise<unknown> {
  const localFetch = opts.fetch;
  const daemon = localFetch ? null : resolveDaemon(opts.storageRoot);
  const url = localFetch ? path : `${daemon!.baseUrl}${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (daemon) headers.authorization = `Bearer ${daemon.token}`;
  const res = await (localFetch ?? fetch)(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`penumbra maestro: HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function printJson(opts: { print?: (line: string) => void }, body: unknown): Promise<void> {
  const print = opts.print ?? defaultPrint;
  print(JSON.stringify(body, null, 2));
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
      const consumedWallClock = session.consumed_wall_clock_ms ?? 0;
      const consumedCost = session.cost_consumed_cents ?? 0;
      const consumedSubDispatches = session.sub_dispatches_consumed ?? 0;
      wall = pct(consumedWallClock, session.wall_clock_budget_ms);
      cost = pct(consumedCost, session.cost_budget_cents);
      sub = pct(consumedSubDispatches, session.sub_dispatch_budget);
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

export async function runMaestroSessionGet(opts: RunMaestroSessionGetOpts): Promise<void> {
  const body = await request({ storageRoot: opts.storageRoot, fetch: opts.fetch }, 'GET', `/maestro/sessions/${encodeURIComponent(opts.task_id)}`);
  await printJson(opts, body);
}

export async function runMaestroSessionStart(opts: RunMaestroSessionStartOpts): Promise<void> {
  const body = await request({ storageRoot: opts.storageRoot, fetch: opts.fetch }, 'POST', '/maestro/sessions', {
    task_id: opts.task_id,
    chain_handoff_id: opts.chain_handoff_id,
    agent_id: opts.agent,
    wall_clock_budget_ms: opts.wall_budget_ms,
    cost_budget_cents: opts.cost_budget_cents,
    sub_dispatch_budget: opts.sub_dispatch_budget,
  });
  await printJson(opts, body);
}

export async function runMaestroSessionStartAdhoc(opts: RunMaestroSessionStartAdhocOpts): Promise<void> {
  const body = await request({ storageRoot: opts.storageRoot, fetch: opts.fetch }, 'POST', '/maestro/sessions/adhoc', {
    message: opts.message,
    agent_id: opts.agent,
    wall_clock_budget_ms: opts.wall_budget_ms,
    cost_budget_cents: opts.cost_budget_cents,
    sub_dispatch_budget: opts.sub_dispatch_budget,
    project_id: opts.project_id,
  });
  await printJson(opts, body);
}

export async function dispatchMaestroSubcommand(args: string[], storageRoot: string): Promise<number> {
  const sub = args[0];
  if (sub === 'list') {
    await runMaestroList({ json: args.includes('--json'), storageRoot });
    return 0;
  }
  if (sub === 'session') {
    const action = args[1];
    if (action === 'get') {
      const taskId = args[2];
      if (!taskId || taskId.startsWith('-')) return invalidUsage('penumbra maestro session get <task-id> [--json]');
      await runMaestroSessionGet({ json: args.includes('--json'), storageRoot, task_id: taskId });
      return 0;
    }
    if (action === 'start') {
      const taskId = readArgValue(args, '--task-id');
      const chainHandoffId = readArgValue(args, '--chain-handoff-id');
      const agent = readArgValue(args, '--agent');
      const wallBudgetMsRaw = readArgValue(args, '--wall-budget-ms');
      const costBudgetCentsRaw = readArgValue(args, '--cost-budget-cents');
      const subDispatchBudgetRaw = readArgValue(args, '--sub-dispatch-budget');
      if (!taskId || !agent || !wallBudgetMsRaw || !costBudgetCentsRaw || !subDispatchBudgetRaw) {
        return invalidUsage('penumbra maestro session start --task-id <id> --agent <name> --wall-budget-ms <n> --cost-budget-cents <n> --sub-dispatch-budget <n> [--chain-handoff-id <id>] [--json]');
      }
      const wall_budget_ms = Number(wallBudgetMsRaw);
      const cost_budget_cents = Number(costBudgetCentsRaw);
      const sub_dispatch_budget = Number(subDispatchBudgetRaw);
      if (!Number.isInteger(wall_budget_ms) || wall_budget_ms <= 0) {
        return invalidUsage('penumbra maestro session start: --wall-budget-ms must be a positive integer');
      }
      if (!Number.isInteger(cost_budget_cents) || cost_budget_cents <= 0) {
        return invalidUsage('penumbra maestro session start: --cost-budget-cents must be a positive integer');
      }
      if (!Number.isInteger(sub_dispatch_budget) || sub_dispatch_budget <= 0) {
        return invalidUsage('penumbra maestro session start: --sub-dispatch-budget must be a positive integer');
      }
      await runMaestroSessionStart({
        json: args.includes('--json'),
        storageRoot,
        task_id: taskId,
        chain_handoff_id: chainHandoffId,
        agent,
        wall_budget_ms,
        cost_budget_cents,
        sub_dispatch_budget,
      });
      return 0;
    }
    if (action === 'start-adhoc') {
      const message = readArgValue(args, '--message');
      const agent = readArgValue(args, '--agent');
      const wallBudgetMsRaw = readArgValue(args, '--wall-budget-ms');
      const costBudgetCentsRaw = readArgValue(args, '--cost-budget-cents');
      const subDispatchBudgetRaw = readArgValue(args, '--sub-dispatch-budget');
      const projectId = readArgValue(args, '--project-id');
      if (!message || !agent || !wallBudgetMsRaw || !costBudgetCentsRaw || !subDispatchBudgetRaw) {
        return invalidUsage('penumbra maestro session start-adhoc --agent <name> --message <text> --wall-budget-ms <n> --cost-budget-cents <n> --sub-dispatch-budget <n> [--project-id <id>] [--json]');
      }
      const wall_budget_ms = Number(wallBudgetMsRaw);
      const cost_budget_cents = Number(costBudgetCentsRaw);
      const sub_dispatch_budget = Number(subDispatchBudgetRaw);
      if (!Number.isInteger(wall_budget_ms) || wall_budget_ms <= 0) {
        return invalidUsage('penumbra maestro session start-adhoc: --wall-budget-ms must be a positive integer');
      }
      if (!Number.isInteger(cost_budget_cents) || cost_budget_cents <= 0) {
        return invalidUsage('penumbra maestro session start-adhoc: --cost-budget-cents must be a positive integer');
      }
      if (!Number.isInteger(sub_dispatch_budget) || sub_dispatch_budget <= 0) {
        return invalidUsage('penumbra maestro session start-adhoc: --sub-dispatch-budget must be a positive integer');
      }
      await runMaestroSessionStartAdhoc({
        json: args.includes('--json'),
        storageRoot,
        message,
        agent,
        wall_budget_ms,
        cost_budget_cents,
        sub_dispatch_budget,
        project_id: projectId,
      });
      return 0;
    }
  }
  return invalidUsage('penumbra maestro <list|session>');
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

function readArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('-')) return undefined;
  return value;
}

function invalidUsage(message: string): number {
  console.error(`usage: ${message}`);
  return 1;
}
