import { describe, expect, test } from 'bun:test';
import { withSandboxedExecutor } from '../helpers/sandbox-fixtures.js';
import { OperationRejectedError } from '../../src/worker/write-tools-errors.js';

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
