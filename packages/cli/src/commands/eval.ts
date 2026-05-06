import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliStorageRoot } from '../storage-root.js';
import { runEval } from '../../../eval/src/run.ts';
import { queryRows } from '../../../eval/src/store/sqlite.ts';
import { Database } from 'bun:sqlite';
import { renderCard } from '../../../eval/src/report/render-card.ts';

function resolveRoot(): string {
  return process.env.DEV_STORAGE ?? resolveCliStorageRoot();
}

export async function runEvalCommand(opts: { model: string; node?: string; ub: number; all?: boolean }): Promise<void> {
  const storageRoot = resolveRoot();
  const ubs = opts.all ? [256, 512] : [opts.ub];
  for (const ub of ubs) runEval({ storageRoot, model: opts.model, node: opts.node, ub });
  console.log(`wrote eval artifacts under ${join(storageRoot, 'eval')}`);
}

export async function runEvalReport(opts: { model: string }): Promise<void> {
  const storageRoot = resolveRoot();
  const dbPath = join(storageRoot, 'eval', 'leaderboard.sqlite');
  if (!existsSync(dbPath)) throw new Error('no eval leaderboard found');
  const db = new Database(dbPath);
  try {
    const rows = queryRows(db, {}).filter((row) => row.model_id === opts.model);
    console.log(renderCard({
      modelId: opts.model,
      source: rows[0]?.source ?? 'unknown',
      hwMatrix: rows.map((row) => ({ node: row.node, ub: row.ub, throughput_tps: row.throughput_tps })),
      subBenches: rows.map((row) => ({
        name: `${row.node}/${row.ub}`,
        ub: row.ub,
        throughput_tps: row.throughput_tps,
        tool_call_score: row.tool_call_score,
        context_8k_score: row.context_8k_score,
        context_16k_score: row.context_16k_score,
        json_score: row.json_score,
        composite_score: row.composite_score,
      })),
    }));
  } finally {
    db.close();
  }
}

export async function runEvalLeaderboard(opts: { node?: string; sort_by?: string }): Promise<void> {
  const storageRoot = resolveRoot();
  const dbPath = join(storageRoot, 'eval', 'leaderboard.sqlite');
  if (!existsSync(dbPath)) {
    console.log('(no eval leaderboard rows)');
    return;
  }
  const db = new Database(dbPath);
  try {
    const rows = queryRows(db, { node: opts.node, sort_by: opts.sort_by as any });
    console.log(['model_id', 'node', 'ub', 'throughput_tps', 'tool_call_score', 'composite_score'].join('\t'));
    for (const row of rows) console.log([row.model_id, row.node, row.ub, row.throughput_tps, row.tool_call_score, row.composite_score].join('\t'));
  } finally {
    db.close();
  }
}

export async function dispatchEvalSubcommand(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'run': {
      const model = args[1];
      if (!model || model.startsWith('-')) {
        console.error('usage: penumbra eval run <model> [--node <name>] [--ub <256|512>] [--all]');
        return 2;
      }
      const nodeIdx = args.indexOf('--node');
      const node = nodeIdx >= 0 ? args[nodeIdx + 1] : undefined;
      const ubIdx = args.indexOf('--ub');
      const ub = ubIdx >= 0 ? Number(args[ubIdx + 1]) : 512;
      await runEvalCommand({ model, node, ub, all: args.includes('--all') });
      return 0;
    }
    case 'report': {
      const model = args[1];
      if (!model || model.startsWith('-')) return 2;
      await runEvalReport({ model });
      return 0;
    }
    case 'leaderboard':
      await runEvalLeaderboard({ node: args.includes('--node') ? args[args.indexOf('--node') + 1] : undefined, sort_by: args.includes('--sort-by') ? args[args.indexOf('--sort-by') + 1] : undefined });
      return 0;
    default:
      console.error('usage: penumbra eval <run|report|leaderboard>');
      return 2;
  }
}
