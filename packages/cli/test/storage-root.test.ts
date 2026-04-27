import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCliStorageRoot } from '../src/storage-root.js';

test('resolveCliStorageRoot prefers PENUMBRA_STORAGE_ROOT over autodiscovery', () => {
  const root = resolveCliStorageRoot({
    explicit: '/explicit/path',
    env: { PENUMBRA_STORAGE_ROOT: '/custom/env' },
    candidates: ['/candidate'],
    existsSync: () => true,
  });
  expect(root).toBe('/explicit/path');
});

test('resolveCliStorageRoot auto-discovers the active daemon root when env is unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-storage-root-'));
  try {
    writeFileSync(join(dir, 'port'), '4242\n');
    writeFileSync(join(dir, 'token'), 'tok\n');
    const root = resolveCliStorageRoot({
      explicit: '',
      env: {},
      candidates: [dir, '/tmp/unused'],
    });
    expect(root).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
