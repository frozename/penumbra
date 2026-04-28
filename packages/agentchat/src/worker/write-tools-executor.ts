import type { Logger } from '@penumbra/core';
import { resolveInsideWorktree, FsPathError } from '@penumbra/core';
import type { PermissionCallback } from './permission-callback.js';
import type { ToolCallContext } from '../sdk/adapter.js';
import { OperationRejectedError, OutsideWorktreeError, NotAFileError, IoError } from './write-tools-errors.js';
import type { SandboxConfig } from './sandbox-config.js';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, readFile, rename, stat, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, isAbsolute, relative } from 'node:path';

export interface AuditEmitter {
  emit(eventType: string, payload: unknown): Promise<void>;
}

export interface WriteToolsExecutorOpts {
  worktreeRoot: string;
  permissionCallback: PermissionCallback;
  auditEmitter: AuditEmitter;
  sandboxConfig: SandboxConfig;
  logger: Pick<Logger, 'warn' | 'info' | 'debug' | 'error'>;
  /** Dispatch + handoff identity for audit emission and one-shot terminal scoping */
  handoffId: string;
  dispatchId: string;
}

export interface ExitStatus {
  exitCode: number;
  signal: string | null;
}

export class WriteToolsExecutor {
  private readonly oneShotTerminals = new Map<string, unknown>();
  private disposed = false;

  constructor(private readonly opts: WriteToolsExecutorOpts) {}

  async writeTextFile(args: { path: string; content: string }, ctx: ToolCallContext): Promise<{ bytesWritten: number; sha256: string }> {
    await this.gate(ctx);
    const real = await this.resolvePath(args.path);
    let prev_sha256: string | null = null;
    try {
      const st = await stat(real);
      if (st.isDirectory()) throw new NotAFileError(`path is a directory: ${args.path}`);
      const existing = await readFile(real);
      prev_sha256 = createHash('sha256').update(existing).digest('hex');
    } catch (err: any) {
      if (err instanceof NotAFileError) throw err;
      if (err?.code !== 'ENOENT') throw new IoError(`failed to stat ${args.path}: ${err?.message ?? err}`);
    }

    await this.ensureParentDir(args.path, real);

    const tmp = `${real}.tmp.${randomUUID()}`;
    try {
      await writeFile(tmp, args.content, 'utf8');
      await rename(tmp, real);
    } catch (err: any) {
      throw new IoError(`failed to write ${args.path}: ${err?.message ?? err}`);
    }

    const sha256 = createHash('sha256').update(args.content, 'utf8').digest('hex');
    const bytesWritten = Buffer.byteLength(args.content, 'utf8');

    await this.opts.auditEmitter.emit('fs.write_applied', {
      path: args.path,
      bytes: bytesWritten,
      sha256,
      prev_sha256,
      handoff_id: this.opts.handoffId,
    });
    return { bytesWritten, sha256 };
  }

  protected async resolvePath(p: string): Promise<string> {
    try {
      return await resolveInsideWorktree(p, this.opts.worktreeRoot);
    } catch (err: any) {
      if (err instanceof FsPathError) {
        if (err.code === 'outside_worktree') throw new OutsideWorktreeError(err.message);
        if (err.code === 'not_found') {
          const worktreeReal = await realpath(resolve(this.opts.worktreeRoot));
          const candidate = isAbsolute(p) ? resolve(p) : resolve(worktreeReal, p);
          
          let current = candidate;
          let existingReal: string | null = null;
          while (current !== dirname(current)) {
            try {
              existingReal = await realpath(current);
              break;
            } catch {
              current = dirname(current);
            }
          }
          
          if (existingReal) {
            const rel = relative(worktreeReal, existingReal);
            if (rel.startsWith('..') || isAbsolute(rel)) {
              throw new OutsideWorktreeError(`path "${p}" resolves outside worktree`);
            }
          }
          return candidate;
        }
        throw new IoError(err.message);
      }
      throw err;
    }
  }

  protected async ensureParentDir(userPath: string, resolvedReal: string): Promise<void> {
    const parts = userPath.split('/').filter(Boolean);
    if (parts.length <= 1) return;
    if (parts.length > 4) throw new IoError(`parent depth too deep for auto-create: ${userPath}`);
    await mkdir(dirname(resolvedReal), { recursive: true });
  }

  async editTextFile(
    _args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
    _ctx: ToolCallContext,
  ): Promise<{ bytesAdded: number; bytesRemoved: number; sha256: string }> {
    throw new Error('editTextFile: not implemented — Task 11');
  }

  async terminalCreate(
    _args: { command?: string; argv?: string[]; cwd?: string; output_byte_limit?: number },
    _ctx: ToolCallContext,
  ): Promise<{ terminal_id: string }> {
    throw new Error('terminalCreate: not implemented — Task 12');
  }

  async terminalOutput(
    _args: { terminal_id: string },
  ): Promise<{ output: string; truncated: boolean; exit_status?: ExitStatus }> {
    throw new Error('terminalOutput: not implemented — Task 12');
  }

  async terminalWaitForExit(
    _args: { terminal_id: string },
  ): Promise<{ exit_status: ExitStatus }> {
    throw new Error('terminalWaitForExit: not implemented — Task 12');
  }

  async terminalRelease(_args: { terminal_id: string }): Promise<void> {
    throw new Error('terminalRelease: not implemented — Task 12');
  }

  async terminalKill(_args: { terminal_id: string }): Promise<void> {
    throw new Error('terminalKill: not implemented — Task 12');
  }

  /** Idempotent. Called from dispatcher cleanup hook. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.oneShotTerminals.clear();
  }

  /** Runs the permission callback and throws OperationRejectedError on reject. */
  protected async gate(ctx: ToolCallContext): Promise<void> {
    const decision = await this.opts.permissionCallback(ctx);
    if (decision !== 'approve') throw new OperationRejectedError(`permission denied: ${ctx.toolName}`);
  }

  /** Test seam — exposes the one-shot map for assertions only. */
  get __oneShotTerminals(): Map<string, unknown> { return this.oneShotTerminals; }
}
