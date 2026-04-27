import { expect, test } from 'bun:test';
import { resolveDaemonStorageRoot } from '../src/daemon-discovery.js';

test('resolveDaemonStorageRoot prefers PENUMBRA_STORAGE_ROOT over autodiscovery', () => {
  const root = resolveDaemonStorageRoot({ env: { PENUMBRA_STORAGE_ROOT: '/custom/env' } });
  expect(root).toBe('/custom/env');
});

test('resolveDaemonStorageRoot honors explicit opts.explicit override', () => {
  const root = resolveDaemonStorageRoot({
    explicit: '/explicit/path',
    env: { PENUMBRA_STORAGE_ROOT: '/custom/env' }
  });
  expect(root).toBe('/explicit/path');
});

test('resolveDaemonStorageRoot picks the first candidate path with port+token files', () => {
  const root = resolveDaemonStorageRoot({
    env: {},
    candidates: ['/cand1', '/cand2'],
    existsSync: (path) => path.startsWith('/cand2/port') || path.startsWith('/cand2/token')
  });
  expect(root).toBe('/cand2');
});

test('resolveDaemonStorageRoot lists every checked candidate when nothing is running', () => {
  expect(() => {
    resolveDaemonStorageRoot({
      env: {},
      candidates: ['/cand1', '/cand2'],
      existsSync: () => false
    });
  }).toThrow(/penumbra daemon not found\. Checked candidate paths: \/cand1, \/cand2/);
});