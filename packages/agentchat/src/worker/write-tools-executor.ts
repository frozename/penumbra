import type { Logger } from '@penumbra/core';
import type { PermissionCallback } from './permission-callback.js';
import type { ToolCallContext } from '../sdk/adapter.js';
import { OperationRejectedError } from './write-tools-errors.js';
import type { SandboxConfig } from './sandbox-config.js';

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

  async writeTextFile(
    _args: { path: string; content: string },
    _ctx: ToolCallContext,
  ): Promise<{ bytesWritten: number; sha256: string }> {
    throw new Error('writeTextFile: not implemented — Task 10');
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
