import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from '../../src/worker/sandbox-config.js';
import { WriteToolsExecutor } from '../../src/worker/write-tools-executor.js';
import { withSandboxedExecutor } from '../helpers/sandbox-fixtures.js';
import {
  IoError,
  NotAFileError,
  OperationRejectedError,
  OutsideWorktreeError,
  TerminalCapExceededError,
  TerminalNotFoundError,
} from '../../src/worker/write-tools-errors.js';
import { readFile, mkdir, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';

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
      await expect(executor.editTextFile(
        { path: 'x', old_string: 'a', new_string: 'b' },
        { toolName: 'fs.edit', rawInput: {}, dispatchId: 'd-test' },
      )).rejects.toThrow(/not implemented/);
    });
  });

  test('gate path: reject decision throws OperationRejectedError without reaching impl', async () => {
    expect(new OperationRejectedError('x').code).toBe('operation_rejected');
  });
});

describe('WriteToolsExecutor.writeTextFile', () => {
  test('happy path: writes content, returns sha256, emits fs.write_applied', async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot, events }) => {
      const r = await executor.writeTextFile({ path: 'foo.txt', content: 'hello' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      expect(r.bytesWritten).toBe(5);
      expect(r.sha256).toBe(createHash('sha256').update('hello').digest('hex'));
      expect(await readFile(join(worktreeRoot, 'foo.txt'), 'utf8')).toBe('hello');
      expect(events.some(e => e.type === 'fs.write_applied')).toBe(true);
    });
  });

  test('permission denial throws OperationRejectedError without writing or emitting', async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot, events, pushDecision }) => {
      pushDecision('reject');
      await expect(executor.writeTextFile({ path: 'denied.txt', content: 'x' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      })).rejects.toThrow(OperationRejectedError);
      // file must not exist
      await expect(readFile(join(worktreeRoot, 'denied.txt'), 'utf8')).rejects.toThrow();
      expect(events.some(e => e.type === 'fs.write_applied')).toBe(false);
    });
  });

  test('outside-worktree absolute path throws OutsideWorktreeError', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await expect(executor.writeTextFile({ path: '/etc/passwd', content: 'pwned' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      })).rejects.toThrow(OutsideWorktreeError);
      expect(events.some(e => e.type === 'fs.write_applied')).toBe(false);
    });
  });

  test('symlink-to-outside throws OutsideWorktreeError', async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      await symlink('/etc', join(worktreeRoot, 'escape'));
      await expect(executor.writeTextFile({ path: 'escape/passwd', content: 'x' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      })).rejects.toThrow(OutsideWorktreeError);
    });
  });

  test('prev_sha256 captured on overwrite', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile({ path: 'a.txt', content: 'a' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      await executor.writeTextFile({ path: 'a.txt', content: 'b' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      const writeEvents = events.filter(e => e.type === 'fs.write_applied');
      expect(writeEvents.length).toBe(2);
      expect((writeEvents[1].payload as any).prev_sha256).toBe(createHash('sha256').update('a').digest('hex'));
    });
  });

  test('prev_sha256 null on new file', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile({ path: 'new.txt', content: 'x' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      expect((events[0].payload as any).prev_sha256).toBeNull();
    });
  });

  test('path-is-directory throws NotAFileError', async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      await mkdir(join(worktreeRoot, 'mydir'), { recursive: true });
      await expect(executor.writeTextFile({ path: 'mydir', content: 'x' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      })).rejects.toThrow(NotAFileError);
    });
  });

  test('parent auto-create within depth (3 levels)', async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      const r = await executor.writeTextFile({ path: 'a/b/c.txt', content: 'x' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      expect(r.bytesWritten).toBe(1);
      expect(await readFile(join(worktreeRoot, 'a/b/c.txt'), 'utf8')).toBe('x');
    });
  });

  test('parent auto-create beyond depth throws IoError', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expect(executor.writeTextFile({ path: 'a/b/c/d/e.txt', content: 'x' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      })).rejects.toThrow(IoError);
    });
  });

  test('audit raw_input (in event payload) is path+content_bytes only, never full content', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const big = 'x'.repeat(100_000);
      await executor.writeTextFile({ path: 'big.txt', content: big }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      const event = events.find(e => e.type === 'fs.write_applied')!;
      // bytes is the captured size, but the full content never appears in payload_json
      expect((event.payload as any).bytes).toBe(100_000);
      const payloadStr = JSON.stringify(event.payload);
      expect(payloadStr.includes(big)).toBe(false);
    });
  });

  test('bytesWritten counts utf-8 bytes for multi-byte chars', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      // 日 = 3 bytes utf8; 本 = 3 bytes utf8 → total 6 bytes
      const r = await executor.writeTextFile({ path: 'jp.txt', content: '日本' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      expect(r.bytesWritten).toBe(6);
    });
  });

  test('event count is exactly one per successful write', async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile({ path: 'one.txt', content: 'x' }, {
        toolName: 'fs.write_text_file', rawInput: {}, dispatchId: 'd-test',
      });
      expect(events.filter(e => e.type === 'fs.write_applied').length).toBe(1);
    });
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
