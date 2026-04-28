import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const FsGrepInputShape = {
  pattern: z.string().min(1).describe('Regular expression to search for.'),
  path: z.string().optional().describe('Optional sub-path inside the worktree to search; defaults to worktree root.'),
  glob: z.string().optional().describe('Optional file pattern filter (e.g. "*.ts").'),
  output_mode: z.enum(['content', 'files_with_matches']).optional().describe('Default "content" returns matching lines; "files_with_matches" returns just paths.'),
  case_insensitive: z.boolean().optional().describe('Case-insensitive match. Default false.'),
  include_ignored: z.boolean().optional().describe('Search files normally excluded by .gitignore. Default false.'),
  max_results: z.number().int().positive().max(5000).optional().describe('Soft cap. Default: content=50 (ceiling 500), files_with_matches=1000 (ceiling 5000).'),
  handoff_id: z.string().optional().describe('Worktree to scope the search to. Defaults to PENUMBRA_HANDOFF_ID env var.'),
};

function errorContent(code: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

function toErrorContent(err: any) {
  const code = err?.body?.error?.code ?? (err?.status === 404 ? 'not_found' : 'internal_error');
  const message = err?.body?.error?.message ?? err?.message ?? 'unknown error';
  return errorContent(code, message);
}

export function fsGrepHandler(daemon: DaemonClient) {
  return async (input: any) => {
    const handoff_id = input.handoff_id || process.env.PENUMBRA_HANDOFF_ID;
    if (!handoff_id) {
      return errorContent('no_handoff_context', 'pass handoff_id explicitly or run inside a dispatch (PENUMBRA_HANDOFF_ID env var unset)');
    }

    const outputMode = input.output_mode ?? 'content';
    if (outputMode === 'content' && typeof input.max_results === 'number' && input.max_results > 500) {
      return errorContent('invalid_args', 'max_results must be <= 500 for content mode');
    }

    try {
      const result = await daemon.grepInWorktree(handoff_id, {
        pattern: input.pattern,
        path: input.path ?? null,
        glob: input.glob ?? null,
        output_mode: outputMode,
        case_insensitive: input.case_insensitive === true,
        include_ignored: input.include_ignored === true,
        max_results: input.max_results ?? null,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return toErrorContent(err);
    }
  };
}
