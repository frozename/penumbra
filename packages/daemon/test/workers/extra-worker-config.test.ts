import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@penumbra/core';
import {
  ExtraWorkersConfigError,
  loadExtraWorkersConfig,
} from '../../src/workers/config.js';

const tempDirs: string[] = [];
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'penumbra-worker-config-'));
  process.env.HOME = home;
  mkdirSync(join(home, '.penumbra'));
  tempDirs.push(home);
});

afterEach(() => {
  process.env.HOME = prevHome;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function writeConfig(contents: string): string {
  const home = process.env.HOME as string;
  const configPath = join(home, '.penumbra', 'workers.yaml');
  writeFileSync(configPath, contents);
  return configPath;
}

function setWorkerId(id: string): void {
  const home = process.env.HOME as string;
  writeFileSync(join(home, '.penumbra', 'worker-id'), `${id}\n`);
}

function withWarnSpy() {
  const entries: unknown[] = [];
  const warnSpy = spyOn(console, 'warn').mockImplementation((entry: unknown) => {
    entries.push(entry);
  });
  return { entries, warnSpy };
}

describe('extra workers config loader', () => {
  test('missing file returns empty extras', () => {
    const { entries, warnSpy } = withWarnSpy();
    try {
      const result = loadExtraWorkersConfig();
      expect(result.extras).toEqual([]);
      expect(entries).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('single extra without project_id gets default concurrency and shared isolation', () => {
    writeConfig(`extras:
  - id: local-worker
`);
    const result = loadExtraWorkersConfig();

    expect(result).toEqual({
      extras: [{
        id: 'local-worker',
        concurrency: 4,
        isolation: 'shared',
      }],
    });
  });

  test('single extra with project_id defaults isolation to sticky', () => {
    writeConfig(`extras:
  - id: sticky-worker
    project_id: penumbra
`);
    const result = loadExtraWorkersConfig();

    expect(result.extras[0]).toMatchObject({
      id: 'sticky-worker',
      project_id: 'penumbra',
      concurrency: 4,
      isolation: 'sticky',
    });
  });

  test('explicit concurrency, isolation, and project_id are preserved', () => {
    writeConfig(`extras:
  - id: custom-worker
    concurrency: 8
    isolation: hard
    project_id: penumbra
`);
    const result = loadExtraWorkersConfig();

    expect(result).toEqual({
      extras: [{
        id: 'custom-worker',
        project_id: 'penumbra',
        concurrency: 8,
        isolation: 'hard',
      }],
    });
  });

  test('duplicate worker ids are rejected', () => {
    writeConfig(`extras:
  - id: duplicate
  - id: duplicate
`);
    expect(() => loadExtraWorkersConfig()).toThrow(ExtraWorkersConfigError);
  });

  test('rejects extras list longer than 32 items', () => {
    writeConfig([
      'extras:',
      ...Array.from({ length: 33 }, (_, index) => `  - id: worker-${index + 1}`),
    ].join('\n'));
    expect(() => loadExtraWorkersConfig()).toThrow(/32/);
  });

  test.each([0, -1, 33, Number.MAX_SAFE_INTEGER + 1])('rejects invalid concurrency %s', (concurrency) => {
    writeConfig(`extras:
  - id: too-many
    concurrency: ${concurrency}
`);
    expect(() => loadExtraWorkersConfig()).toThrow(ExtraWorkersConfigError);
  });

  test.each([
    'worker/extra',
    'worker.1',
    '',
    'a'.repeat(65),
  ])('invalid extra id "%s" is rejected', (id) => {
    const safeId = id === '' ? '""' : id;
    writeConfig(`extras:
  - id: ${safeId}
`);
    expect(() => loadExtraWorkersConfig()).toThrow(ExtraWorkersConfigError);
  });

  test('primary worker-id collision is rejected', () => {
    setWorkerId('primary-worker');
    writeConfig(`extras:
  - id: primary-worker
`);
    expect(() => loadExtraWorkersConfig()).toThrow(ExtraWorkersConfigError);
  });

  test('unknown project_id is skipped with warning', () => {
    const { entries, warnSpy } = withWarnSpy();
    try {
      writeConfig(`extras:
  - id: unknown-project
    project_id: missing
`);
      const result = loadExtraWorkersConfig({ projectRegistry: { has: () => false } });
    expect(result.extras).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      event: 'extra_worker_unknown_project',
      worker_id: 'unknown-project',
      project_id: 'missing',
    });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('unknown project_id warning is logged through logger when logger is provided', () => {
    const warningCalls: unknown[] = [];
    const log = {
      warn: (...args: unknown[]) => {
        warningCalls.push(args);
      },
    } as unknown as Logger;
    writeConfig(`extras:
  - id: unknown-project
    project_id: missing
`);
    const result = loadExtraWorkersConfig({ projectRegistry: { has: () => false }, log });
    expect(result.extras).toEqual([]);
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0]).toEqual([
      {
        event: 'extra_worker_unknown_project',
        worker_id: 'unknown-project',
        project_id: 'missing',
      },
      'extra worker references unknown project_id and will be skipped',
    ]);
  });

  test('unknown project_id is accepted when no project registry is available', () => {
    writeConfig(`extras:
  - id: untracked-project
    project_id: i-really-do-not-exist
`);
    const result = loadExtraWorkersConfig();
    expect(result.extras).toEqual([{
      id: 'untracked-project',
      project_id: 'i-really-do-not-exist',
      concurrency: 4,
      isolation: 'sticky',
    }]);
  });

  test('invalid isolation value is rejected', () => {
    writeConfig(`extras:
  - id: isolation-bad
    isolation: unknown
`);
    expect(() => loadExtraWorkersConfig()).toThrow(ExtraWorkersConfigError);
  });
});
