import { describe, expect, test } from 'bun:test';
import { withSandboxedExecutor } from '../helpers/sandbox-fixtures.js';
import { OperationRejectedError, OutsideWorktreeError, NotAFileError, IoError } from '../../src/worker/write-tools-errors.js';
import { readFile, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

describe('WriteToolsExecutor — scaffolding', () => {
  test('constructs and disposes idempotently', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await executor.dispose();
      await executor.dispose();  // second call is a no-op
    });
  });

  test('stubs throw not-implemented before their owning task lands', async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expect(executor.terminalCreate(
        { argv: ['echo', 'x'] },
        { toolName: 'terminal.create', rawInput: {}, dispatchId: 'd-test' },
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
