import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDaemonStorageRoot } from '@penumbra/core';

export interface RunAgentRankOpts {
  task_type: string;
  since?: string;
  min_samples?: number;
  include_neutral?: boolean;
  json: boolean;
  fetch?: typeof fetch;
  print?: (s: string) => void;
  storageRoot?: string;
}

function defaultPrint(s: string): void {
  process.stdout.write(`${s}\n`);
}

function resolveDaemon(storageRoot?: string): { baseUrl: string; token: string } {
  const root = storageRoot ?? resolveDaemonStorageRoot();
  const port = readFileSync(join(root, 'port'), 'utf8').trim();
  const token = readFileSync(join(root, 'token'), 'utf8').trim();
  if (!port || Number.isNaN(Number(port))) {
    throw new Error(`penumbra agent: invalid daemon port in ${join(root, 'port')}`);
  }
  if (!token) {
    throw new Error(`penumbra agent: empty daemon token in ${join(root, 'token')}`);
  }
  return { baseUrl: `http://127.0.0.1:${Number(port)}`, token };
}

export async function runAgentRank(opts: RunAgentRankOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? defaultPrint;
  const params = new URLSearchParams();
  params.set('task_type', opts.task_type);
  if (opts.since) params.set('since', opts.since);
  if (opts.min_samples != null) params.set('min_samples', String(opts.min_samples));
  if (opts.include_neutral != null) params.set('include_neutral', String(opts.include_neutral));

  const daemon = opts.fetch ? null : resolveDaemon(opts.storageRoot);
  const url = opts.fetch ? `/agents/rank?${params.toString()}` : `${daemon!.baseUrl}/agents/rank?${params.toString()}`;
  const headers = daemon ? { authorization: `Bearer ${daemon.token}` } : undefined;
  const res = await fetcher(url, headers ? { headers } : undefined);
  if (!res.ok) {
    print(`error: HTTP ${res.status}`);
    return;
  }

  const body = await res.json() as {
    task_type: string;
    window: { from: string; to: string };
    candidates: Array<{
      agent_name: string;
      score: number;
      samples: number;
      success_rate: number;
      avg_rounds: number | null;
      avg_latency_ms: number | null;
      cost_per_success_usd: number | null;
    }>;
  };

  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }

  print(`Agent rank -- task_type=${body.task_type} window ${body.window.from} -> ${body.window.to}`);
  print('');
  print('  agent               score  samples  success  avg_rounds  cost/success  latency');
  if (body.candidates.length === 0) {
    print('  (none)');
    return;
  }
  for (const row of body.candidates) {
    const agent = row.agent_name.padEnd(19);
    const score = `${(row.score * 100).toFixed(1)}%`.padEnd(6);
    const samples = String(row.samples).padEnd(7);
    const success = `${(row.success_rate * 100).toFixed(1)}%`.padEnd(8);
    const rounds = (row.avg_rounds == null ? '-' : row.avg_rounds.toFixed(1)).padEnd(10);
    const cost = (row.cost_per_success_usd == null ? '-' : `$${row.cost_per_success_usd.toFixed(4)}`).padEnd(13);
    const latency = row.avg_latency_ms == null ? '-' : `${Math.round(row.avg_latency_ms / 1000)}s`;
    print(`  ${agent} ${score} ${samples} ${success} ${rounds} ${cost} ${latency}`);
  }
}
