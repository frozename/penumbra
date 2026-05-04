import type { Database } from 'bun:sqlite';
import { findActiveTranscriptForCwd } from './transcript-reader.js';

export type StateMetrics = {
  'queue-idle-min': number;
  'time-since-last-handoff-min': number;
  'pending-handoffs': number;
  'commits-since-last-handoff': number;
  'context-window-percent': number;
};

export type GitLogSinceCounter = (sinceIso: string) => number;
export type TranscriptReader = (opts: { cwd: string }) => { estimatedTokens: number } | null;

export type ComputeStateMetricsOpts = {
  db: Database;
  now: () => Date;
  gitLogSince?: GitLogSinceCounter;
  transcriptReader?: TranscriptReader;
  contextBudgetTokens?: number;
  cwd?: string;
};

const defaultGitLogSinceCounter: GitLogSinceCounter = (sinceIso) => {
  const proc = Bun.spawnSync({
    cmd: ['git', 'log', '--since', sinceIso, '--pretty=format:%H'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return 0;
  const out = proc.stdout.toString('utf8').trim();
  return out.length === 0 ? 0 : out.split('\n').length;
};

export function computeStateMetrics(opts: ComputeStateMetricsOpts): StateMetrics {
  const { db, now } = opts;
  const nowMs = now().getTime();
  const pending = db.query("SELECT COUNT(*) AS n FROM handoffs WHERE status = 'pending'").get() as { n: number };
  const lastEnd = db.query("SELECT ts FROM dispatch_events WHERE kind = 'dispatch.end' ORDER BY ts DESC LIMIT 1").get() as
    | { ts: string }
    | undefined;
  const lastHandoff = db.query('SELECT ts FROM handoffs ORDER BY ts DESC LIMIT 1').get() as { ts: string } | undefined;
  const lastSessionHandoff = db
    .query("SELECT ts FROM t0_events WHERE event_type = 'workflow.outcome' AND json_extract(payload_json, '$.workflow_name') = 'session-handoff' ORDER BY ts DESC LIMIT 1")
    .get() as { ts: string } | undefined;

  let commitsSinceLastHandoff: number;
  if (!lastSessionHandoff) {
    commitsSinceLastHandoff = Number.MAX_SAFE_INTEGER;
  } else {
    const counter = opts.gitLogSince ?? defaultGitLogSinceCounter;
    try {
      commitsSinceLastHandoff = counter(lastSessionHandoff.ts);
    } catch {
      commitsSinceLastHandoff = 0;
    }
  }
  const transcriptReader = opts.transcriptReader ?? ((o) => findActiveTranscriptForCwd(o));
  const cwd = opts.cwd ?? process.cwd();
  const transcript = transcriptReader({ cwd });
  const budget = opts.contextBudgetTokens ?? 200_000;
  const contextPct = transcript ? Math.min(100, Math.round((transcript.estimatedTokens / budget) * 100)) : 0;

  return {
    'pending-handoffs': pending.n,
    'queue-idle-min': lastEnd ? Math.max(0, Math.floor((nowMs - new Date(lastEnd.ts).getTime()) / 60000)) : 0,
    'time-since-last-handoff-min': lastHandoff ? Math.max(0, Math.floor((nowMs - new Date(lastHandoff.ts).getTime()) / 60000)) : 0,
    'commits-since-last-handoff': commitsSinceLastHandoff,
    'context-window-percent': contextPct,
  };
}
