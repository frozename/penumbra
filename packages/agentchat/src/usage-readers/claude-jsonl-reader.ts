import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageReader, UsageReaderResult, UsageReaderDelta } from './index.js';

export interface ClaudeJsonlReaderOptions {
  rootDir?: string;
}

interface FileCursor { byte_offset: number; mtime_ms: number; }
interface ClaudeJsonlCursor { files: Record<string, FileCursor>; }

export class ClaudeJsonlReader implements UsageReader {
  readonly id = 'claude-jsonl';
  private rootDir: string;

  constructor(opts: ClaudeJsonlReaderOptions = {}) {
    this.rootDir = opts.rootDir ?? join(homedir(), '.claude', 'projects');
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    if (!existsSync(this.rootDir)) {
      return { cursor: previousCursor ?? { files: {} }, usage_deltas: [], rate_limit_snapshots: [] };
    }
    const cursor: ClaudeJsonlCursor = (previousCursor as ClaudeJsonlCursor | null) ?? { files: {} };
    const newCursor: ClaudeJsonlCursor = { files: { ...cursor.files } };

    const buckets = new Map<string, UsageReaderDelta>();
    const projectDirs = readdirSync(this.rootDir, { withFileTypes: true }).filter(d => d.isDirectory());

    for (const projDir of projectDirs) {
      const projectPath = join(this.rootDir, projDir.name);
      let files: import('node:fs').Dirent[];
      try { files = readdirSync(projectPath, { withFileTypes: true }); } catch { continue; }
      for (const fEnt of files) {
        if (!fEnt.isFile() || !fEnt.name.endsWith('.jsonl')) continue;
        const filePath = join(projectPath, fEnt.name);
        const stats = statSync(filePath);
        const fileCursor = newCursor.files[filePath];
        if (fileCursor && fileCursor.byte_offset >= stats.size) continue;
        const buf = readFileSync(filePath, 'utf8');
        const slice = buf.slice(fileCursor?.byte_offset ?? 0);
        for (const rawLine of slice.split('\n')) {
          const line = rawLine.trim();
          if (!line) continue;
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj?.type !== 'assistant') continue;
          const usage = obj?.message?.usage;
          if (!usage) continue;
          const model = obj?.message?.model ?? null;
          const key = `anthropic\0${model ?? ''}`;
          let b = buckets.get(key);
          if (!b) {
            b = {
              provider: 'anthropic', model,
              tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0,
              cost_usd: null,
              window_start: new Date().toISOString(),
              window_end: new Date().toISOString(),
            };
            buckets.set(key, b);
          }
          b.tokens_input += Number(usage.input_tokens ?? 0);
          b.tokens_output += Number(usage.output_tokens ?? 0);
          b.tokens_cache_read = (b.tokens_cache_read ?? 0) + Number(usage.cache_read_input_tokens ?? 0);
          b.tokens_cache_write = (b.tokens_cache_write ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
        }
        newCursor.files[filePath] = { byte_offset: stats.size, mtime_ms: stats.mtimeMs };
      }
    }
    /**
     * Claude rate limits intentionally NOT captured here. The canonical source is
     * `ClaudeStatusLineBridge` (see ./claude-statusline-bridge.ts), which reads
     * /tmp/penumbra-claude-rl.json — written by the user's statusline hook from
     * Claude session JSON's `.rate_limits` field. This reader covers per-message
     * token usage only. See docs/superpowers/specs/2026-05-07-subscription-cost-tracking-design.md
     * (Phase 1 forensics: "ClaudeStatusLineBridge is canonical").
     */
    return { cursor: newCursor, usage_deltas: [...buckets.values()], rate_limit_snapshots: [] };
  }
}
