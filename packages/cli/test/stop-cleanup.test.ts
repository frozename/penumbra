import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStop } from '../src/commands/stop.js';
import type { DaemonHandle } from '../../daemon/src/serve.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'penumbra-stop-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('pid and port files are removed even when handle.stop() throws', async () => {
  const pidPath = join(dir, 'pid');
  const portPath = join(dir, 'port');
  writeFileSync(pidPath, '99999\n');
  writeFileSync(portPath, '12345\n');

  const throwingHandle: DaemonHandle = {
    port: 12345,
    stop: () => { throw new Error('supervisor exploded'); },
  };

  // runStop should propagate the throw but still clean up the files.
  await expect(runStop({ storageRoot: dir, handle: throwingHandle })).rejects.toThrow('supervisor exploded');

  expect(existsSync(pidPath)).toBe(false);
  expect(existsSync(portPath)).toBe(false);
});

test('pid and port files are removed when handle is absent', async () => {
  const pidPath = join(dir, 'pid');
  const portPath = join(dir, 'port');
  // Use a near-impossible pid so kill() throws ESRCH and is swallowed.
  writeFileSync(pidPath, '2147483640\n');
  writeFileSync(portPath, '12345\n');

  const result = await runStop({ storageRoot: dir });
  expect(result).toBe(0);
  expect(existsSync(pidPath)).toBe(false);
  expect(existsSync(portPath)).toBe(false);
});
