import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanValidate } from '../../src/commands/plan.js';

const KNOWN_AGENTS = new Set(['codex-acp-fast', 'gemini-acp']);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'penumbra-plan-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function captureStreams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
    },
  };
}

function validBlock(id: string, opts: { parallel_with?: string[] } = {}): string {
  return [
    '```yaml meta',
    `id: "${id}"`,
    `files: [packages/foo/${id}.ts]`,
    'file_scope: modify-existing',
    'depends_on: []',
    `parallel_with: ${JSON.stringify(opts.parallel_with ?? [])}`,
    'preferred_agent: codex-acp-fast',
    'fallback_agent: gemini-acp',
    'task_size: small',
    'risk_class: paste-ready',
    '```',
  ].join('\n');
}

test('runPlanValidate returns 0 for two valid yaml meta blocks', async () => {
  const path = join(workDir, 'plan.md');
  const md = [
    '# Plan',
    '',
    validBlock('1.1'),
    '',
    validBlock('1.2'),
    '',
  ].join('\n');
  await writeFile(path, md, 'utf8');

  const cap = captureStreams();
  const code = await runPlanValidate({
    path,
    repoRoot: workDir,
    knownAgents: KNOWN_AGENTS,
    out: cap.write.out,
    err: cap.write.err,
  });

  expect(code).toBe(0);
  expect(cap.err.join('\n')).toBe('');
});

test('runPlanValidate returns 2 with hint when file has no yaml meta blocks', async () => {
  const path = join(workDir, 'empty.md');
  await writeFile(path, '# Plan\n\nNo yaml meta blocks here.\n', 'utf8');

  const cap = captureStreams();
  const code = await runPlanValidate({
    path,
    repoRoot: workDir,
    knownAgents: KNOWN_AGENTS,
    out: cap.write.out,
    err: cap.write.err,
  });

  expect(code).toBe(2);
  expect(cap.err.join('\n')).toContain('no yaml meta blocks found');
  expect(cap.err.join('\n')).toContain(path);
});

test('runPlanValidate returns 2 and reports parser errors with line numbers', async () => {
  const path = join(workDir, 'malformed.md');
  const md = [
    '# Plan',
    '',
    '```yaml meta',
    'id: 1.1',
    'files: [unterminated',
    '  bad: yaml: : :',
    '```',
    '',
  ].join('\n');
  await writeFile(path, md, 'utf8');

  const cap = captureStreams();
  const code = await runPlanValidate({
    path,
    repoRoot: workDir,
    knownAgents: KNOWN_AGENTS,
    out: cap.write.out,
    err: cap.write.err,
  });

  expect(code).toBe(2);
  const stderr = cap.err.join('\n');
  expect(stderr).toContain('parse:');
  expect(stderr).toContain('malformed.md');
});

test('runPlanValidate returns 2 and reports rule violations with task id', async () => {
  const path = join(workDir, 'bad-parallel.md');
  // Task 1.1 declares parallel_with = ['1.2'] but 1.2 does not exist anywhere → parallel_with_unknown.
  const md = [
    '# Plan',
    '',
    validBlock('1.1', { parallel_with: ['1.2'] }),
    '',
  ].join('\n');
  await writeFile(path, md, 'utf8');

  const cap = captureStreams();
  const code = await runPlanValidate({
    path,
    repoRoot: workDir,
    knownAgents: KNOWN_AGENTS,
    out: cap.write.out,
    err: cap.write.err,
  });

  expect(code).toBe(2);
  const stderr = cap.err.join('\n');
  expect(stderr).toContain('1.1');
  expect(stderr).toContain('parallel_with_unknown');
});
