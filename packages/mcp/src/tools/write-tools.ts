import { z } from 'zod';
// @ts-ignore - path may be resolved differently by bun/tsc
import type { WriteToolsExecutor } from '../../../agentchat/src/worker/write-tools-executor.js';

const WriteFileInput = z.object({
  path: z.string().min(1).describe('Path to the file to write, relative to worktree root.'),
  content: z.string().describe('Complete text content to write.'),
});

const EditInput = z.object({
  path: z.string().min(1).describe('Path to the file to edit.'),
  old_string: z.string().min(1).describe('Exact substring to replace.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z.boolean().optional().describe('If true, replace all occurrences of old_string. Default false (fails if multiple matches).'),
});

const TerminalRunInput = z.object({
  argv: z.array(z.string()).optional().describe('Arguments for the command (preferred).'),
  command: z.string().optional().describe('Full command string to run (shell-style).'),
  cwd: z.string().optional().describe('Current working directory for the command.'),
  timeout_ms: z.number().int().positive().optional().describe('Maximum execution time in milliseconds. Default 30s.'),
}).refine((v) => v.argv !== undefined || v.command !== undefined, {
  message: 'Either argv or command must be provided',
});

export interface WriteToolsContext {
  resolveExecutor: (dispatchId: string) => WriteToolsExecutor | null;
  dispatchId: string;
}

export function registerWriteTools(server: any, ctx: WriteToolsContext): void {
  // fs.write_file
  server.registerTool(
    'fs.write_file',
    {
      description: 'Write content to a file inside the dispatch worktree. Overwrites existing content. Operator approval may be required.',
      inputSchema: WriteFileInput,
    },
    async (input: any) => {
      try {
        const exec = mustExec(ctx);
        const r = await exec.writeTextFile(input, {
          toolName: 'fs.write_file',
          rawInput: { path: input.path, content_bytes: Buffer.byteLength(input.content, 'utf8') },
          dispatchId: ctx.dispatchId,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }] };
      } catch (err) {
        return toErrorContent(err);
      }
    }
  );

  // fs.edit
  server.registerTool(
    'fs.edit',
    {
      description: 'Atomic-replace a unique substring in a file. Throws edit_ambiguous if old_string occurs more than once unless replace_all is true.',
      inputSchema: EditInput,
    },
    async (input: any) => {
      try {
        const exec = mustExec(ctx);
        const r = await exec.editTextFile(input, {
          toolName: 'fs.edit',
          rawInput: {
            path: input.path,
            old_bytes: Buffer.byteLength(input.old_string, 'utf8'),
            new_bytes: Buffer.byteLength(input.new_string, 'utf8'),
          },
          dispatchId: ctx.dispatchId,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...r }) }] };
      } catch (err) {
        return toErrorContent(err);
      }
    }
  );

  // terminal.run
  server.registerTool(
    'terminal.run',
    {
      description: 'Run a single shell command in the dispatch worktree, returning exit_status and output. Operator approval may be required. Default timeout 30s.',
      inputSchema: TerminalRunInput,
    },
    async (input: any) => {
      try {
        const exec = mustExec(ctx);
        const { terminal_id } = await exec.terminalCreate(
          {
            command: input.command,
            argv: input.argv,
            cwd: input.cwd,
            output_byte_limit: undefined,
          },
          {
            toolName: 'terminal.run',
            rawInput: { cmd: input.command ?? null, argv: input.argv ?? null, cwd: input.cwd ?? '.' },
            dispatchId: ctx.dispatchId,
          },
        );
        try {
          const { exit_status } = await exec.terminalWaitForExit({ terminal_id });
          const { output, truncated } = await exec.terminalOutput({ terminal_id });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                exit_status,
                output,
                output_truncated: truncated,
              }),
            }],
          };
        } finally {
          await exec.terminalRelease({ terminal_id }).catch(() => {});
        }
      } catch (err) {
        return toErrorContent(err);
      }
    }
  );
}

function mustExec(ctx: WriteToolsContext): WriteToolsExecutor {
  const e = ctx.resolveExecutor(ctx.dispatchId);
  if (!e) throw new Error(`write-tools executor not available for dispatch ${ctx.dispatchId}`);
  return e;
}

function toErrorContent(err: any) {
  const code = err?.code || 'internal_error';
  const message = err?.message || String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}
