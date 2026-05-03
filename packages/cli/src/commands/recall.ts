import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunRecallOpts {
  storageRoot: string;
  query: string;
  project: string | null;
  limit: number;
  session_id?: string;
  event_types?: string[];
  /**
   * When true, recall searches t0 events too (raw observations). Without this
   * the daemon defaults to t1+t2 only, which means activity from the current
   * minute is invisible until the t1-rollup worker runs.
   */
  include_raw?: boolean;
}

export interface RecallHit {
  id: string;
  tier: string;
  score: number;
  title: string | null;
  body: string;
  project_id: string | null;
  source_session_ids: string[];
  created_at: string;
}

export async function runRecall(opts: RunRecallOpts): Promise<RecallHit[]> {
  const portPath = join(opts.storageRoot, 'port');
  const tokenPath = join(opts.storageRoot, 'token');
  if (!existsSync(portPath) || !existsSync(tokenPath)) {
    throw new Error(`penumbra recall: missing ${portPath} or ${tokenPath}. Run 'penumbra start' first.`);
  }
  const port = Number(readFileSync(portPath, 'utf8').trim());
  const token = readFileSync(tokenPath, 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${port}/recall`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: opts.query,
      project_id: opts.project,
      limit: opts.limit,
      min_score: 0,
      session_id: opts.session_id,
      event_types: opts.event_types,
      include_raw: opts.include_raw,
    }),
  });
  if (!res.ok) {
    throw new Error(`penumbra recall: daemon /recall returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { results: RecallHit[] };
  return body.results;
}
