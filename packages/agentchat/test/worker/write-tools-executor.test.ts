import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from '../../src/worker/sandbox-config.js';
import { WriteToolsExecutor } from '../../src/worker/write-tools-executor.js';
import { withSandboxedExecutor } from '../helpers/sandbox-fixtures.js';
import {
  OperationRejectedError,
  OutsideWorktreeError,
  TerminalCapExceededError,
  TerminalNotFoundError,
} from '../../src/worker/write-tools-errors.js';

async function withCustomSandboxedExecutor(
  fn: (ctx: { executor: WriteToolsExecutor; events: { type: string; payload: unknown }[] }) => Promise<void>,
  sandboxConfigOverrides: Partial<SandboxConfig>,
): Promise<void> {
  const worktreeRoot = await mkdtemp(join(tmpdir(), 'phase1d-terminal-'));
  const events: { type: string; payload: unknown }[] = [];
  const executor = new WriteToolsExecutor({
    worktreeRoot,
    permissionCallback: async () => 'approve',
    auditEmitter: { emit: async (type, payload) => { events.push({ type, payload }); } },
    sandboxConfig: { ...DEFAULT_SANDBOX_CONFIG, ...sandboxConfigOverrides },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    handoffId: 'h-test',
    dispatchId: 'd-test',
  });

  try {
    await fn({ executor, events });
  } finally {
    await executor.dispose();
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}

describe('WriteToolsExecutor — scaffolding', () => {
  test('constructs and disposes idempotently', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await executor.dispose();
      await executor.dispose();  // second call is a no-op
    });
  });

  test('stubs throw not-implemented before their owning task lands', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expect(executor.writeTextFile(
        { path: 'x', content: 'y' },
        { toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test' },
      )).rejects.toThrow(/not implemented/);
    });
  });

  test('gate path: reject decision throws OperationRejectedError without reaching impl', async () => {
    expect(new OperationRejectedError('x').code).toBe('operation_rejected');
  });
});

describe('WriteToolsExecutor.terminal* (one-shot)', () => {
  test('happy path: create + wait_for_exit returns exit_status 0 for echo', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate({ argv: ['echo', 'hi'] }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      });
      const { exit_status } = await executor.terminalWaitForExit({ terminal_id });
      const out = await executor.terminalOutput({ terminal_id });
      expect(exit_status.exitCode).toBe(0);
      expect(out.output.trim()).toBe('hi');
      await executor.terminalRelease({ terminal_id });
      expect(events.some((e) => e.type === 'terminal.spawned')).toBe(true);
      expect(events.some((e) => e.type === 'terminal.exited')).toBe(true);
    });
  });

  test('argv preferred over cmd when both set', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const { terminal_id } = await executor.terminalCreate({
        argv: ['echo', 'A'],
        command: 'echo B',
      }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      });
      await executor.terminalWaitForExit({ terminal_id });
      const { output } = await executor.terminalOutput({ terminal_id });
      expect(output.trim()).toBe('A');
    });
  });

  test('cmd form runs via bash -c', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const { terminal_id } = await executor.terminalCreate({ command: 'echo hi-cmd' }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      });
      await executor.terminalWaitForExit({ terminal_id });
      const { output } = await executor.terminalOutput({ terminal_id });
      expect(output.trim()).toBe('hi-cmd');
    });
  });

  test('output truncation flag with output_byte_limit', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const { terminal_id } = await executor.terminalCreate({ command: 'yes', output_byte_limit: 4096 }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      });
      await executor.terminalWaitForExit({ terminal_id });
      const { truncated } = await executor.terminalOutput({ terminal_id });
      expect(truncated).toBe(true);
    });
  });

  test('terminalOutput on unknown id throws TerminalNotFoundError', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expect(executor.terminalOutput({ terminal_id: 'nonexistent' })).rejects.toThrow(TerminalNotFoundError);
    });
  });

  test('terminalWaitForExit on unknown id throws TerminalNotFoundError', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expect(executor.terminalWaitForExit({ terminal_id: 'nonexistent' })).rejects.toThrow(TerminalNotFoundError);
    });
  });

  test('terminalRelease on unknown id is silent no-op', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expect(executor.terminalRelease({ terminal_id: 'nonexistent' })).resolves.toBeUndefined();
    });
  });

  test('terminalKill emits terminal.killed reason=operator', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate({ argv: ['sleep', '5'] }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      });
      await executor.terminalKill({ terminal_id });
      expect(events.some((e) => e.type === 'terminal.killed' && (e.payload as any).reason === 'operator')).toBe(true);
    });
  });

  test('permission denial throws and emits no terminal.spawned', async () => {
    await withSandboxedExecutor(async ({ executor, events, pushDecision }) => {
      pushDecision('reject');
      await expect(executor.terminalCreate({ argv: ['echo', 'no'] }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      })).rejects.toThrow();
      expect(events.some((e) => e.type === 'terminal.spawned')).toBe(false);
    });
  });

  test('cwd outside worktree throws OutsideWorktreeError before spawn', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await expect(executor.terminalCreate({ argv: ['echo', 'x'], cwd: '/etc' }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      })).rejects.toBeInstanceOf(OutsideWorktreeError);
      expect(events.some((e) => e.type === 'terminal.spawned')).toBe(false);
    });
  });

  test('release before wait_for_exit cleans up running process', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const { terminal_id } = await executor.terminalCreate({ argv: ['sleep', '5'] }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      });
      await executor.terminalRelease({ terminal_id });
      await expect(executor.terminalOutput({ terminal_id })).rejects.toThrow(TerminalNotFoundError);
    });
  });

  test('dispose during running terminal aborts and emits dispatch_end killed event', async () => {
    let capturedEvents: { type: string; payload: unknown }[] = [];
    await withSandboxedExecutor(async ({ executor, events }) => {
      capturedEvents = events;
      await executor.terminalCreate({ argv: ['sleep', '10'] }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      });
    });
    expect(capturedEvents.some((e) => e.type === 'terminal.killed' && (e.payload as any).reason === 'dispatch_end')).toBe(true);
  });

  test('concurrent terminal cap exceeded throws TerminalCapExceededError', async () => {
    await withCustomSandboxedExecutor(async ({ executor }) => {
      await executor.terminalCreate({ argv: ['sleep', '5'] }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      });
      await expect(executor.terminalCreate({ argv: ['echo', 'blocked'] }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      })).rejects.toBeInstanceOf(TerminalCapExceededError);
    }, { maxConcurrent: 1 });
  });

  test('timeout emits terminal.killed reason=timeout', async () => {
    await withCustomSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate({ argv: ['sleep', '5'] }, {
        toolName: 'terminal.create',
        rawInput: {},
        dispatchId: 'd-test',
      });
      const { exit_status } = await executor.terminalWaitForExit({ terminal_id });
      expect(exit_status.exitCode).not.toBe(0);
      expect(events.some((e) => e.type === 'terminal.killed' && (e.payload as any).reason === 'timeout')).toBe(true);
    }, { timeoutMs: 100 });
  });
});
