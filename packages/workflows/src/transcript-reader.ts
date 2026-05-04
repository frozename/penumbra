import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TranscriptInfo = {
  sessionId: string;
  path: string;
  estimatedTokens: number;
  modifiedAt: Date;
};

export type FindTranscriptOpts = {
  cwd: string;
  claudeProjectsRoot?: string;
  now?: Date;
  staleAfterMin?: number;
};

const TOKENS_PER_CHAR = 0.25;

function dirNameForCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function estimateTokensFromJsonlLine(line: string): number {
  if (!line.trim()) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== 'object') return 0;
  const obj = parsed as { message?: { role?: string; content?: unknown } };
  const role = obj.message?.role;
  if (role !== 'user' && role !== 'assistant') return 0;
  const content = obj.message?.content;
  if (typeof content === 'string') return Math.ceil(content.length * TOKENS_PER_CHAR);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      total += Math.ceil(((block as { text: string }).text).length * TOKENS_PER_CHAR);
    }
  }
  return total;
}

export function findActiveTranscriptForCwd(opts: FindTranscriptOpts): TranscriptInfo | null {
  const root = opts.claudeProjectsRoot ?? join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  const subdir = join(root, dirNameForCwd(opts.cwd));
  if (!existsSync(subdir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(subdir);
  } catch {
    return null;
  }
  const jsonl = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonl.length === 0) return null;

  let bestPath: string | null = null;
  let bestMtime = 0;
  for (const file of jsonl) {
    const full = join(subdir, file);
    try {
      const st = statSync(full);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestPath = full;
      }
    } catch {
      continue;
    }
  }
  if (!bestPath) return null;

  const now = opts.now ?? new Date();
  const stalenessMin = (now.getTime() - bestMtime) / 60_000;
  const limit = opts.staleAfterMin ?? 30;
  if (stalenessMin > limit) return null;

  const sessionId = bestPath.split('/').pop()!.replace(/\.jsonl$/, '');

  let totalTokens = 0;
  try {
    const text = readFileSync(bestPath, 'utf8');
    for (const line of text.split('\n')) {
      totalTokens += estimateTokensFromJsonlLine(line);
    }
  } catch {
    /* if we can't read, return what we have */
  }

  return {
    sessionId,
    path: bestPath,
    estimatedTokens: totalTokens,
    modifiedAt: new Date(bestMtime),
  };
}
