import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { AgentsConfigSchema, QuotasConfigSchema, RoutingConfigSchema } from '@penumbra/config';

async function runSplit(args: string[]) {
  const proc = Bun.spawn(['bun', 'packages/cli/bin/penumbra.ts', 'config', 'split', ...args], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'penumbra-config-split-'));
  tempDirs.push(dir);
  return dir;
}

function fixturePath(name: string): string {
  return join(import.meta.dir, 'fixtures', name);
}

describe('penumbra config split', () => {
  test('splits a legacy config fixture into three files', async () => {
    const dir = await makeTempDir();
    const result = await runSplit(['--source', fixturePath('agentchat-legacy.yaml'), '--dest', dir]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, 'agents.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'routing.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'quotas.yaml'))).toBe(true);
  });

  test('output reloads through split schemas', async () => {
    const dir = await makeTempDir();
    const result = await runSplit(['--source', fixturePath('agentchat-legacy.yaml'), '--dest', dir]);
    expect(result.exitCode).toBe(0);

    const agents = AgentsConfigSchema.parse(YAML.parse(readFileSync(join(dir, 'agents.yaml'), 'utf8')));
    const routing = RoutingConfigSchema.parse(YAML.parse(readFileSync(join(dir, 'routing.yaml'), 'utf8')));
    const quotas = QuotasConfigSchema.parse(YAML.parse(readFileSync(join(dir, 'quotas.yaml'), 'utf8')));

    expect(agents.agents[0]?.name).toBe('claude-acp-sonnet');
    expect(routing.skill_rosters?.review.personas).toEqual(['architect', 'security']);
    expect(quotas.providers[0]?.name).toBe('anthropic');
  });

  test('refuses on existing destination without force', async () => {
    const dir = await makeTempDir();
    writeFileSync(join(dir, 'agents.yaml'), 'sentinel: true\n');

    const result = await runSplit(['--source', fixturePath('agentchat-legacy.yaml'), '--dest', dir]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('pass --force');
  });

  test('force overwrites existing files', async () => {
    const dir = await makeTempDir();
    writeFileSync(join(dir, 'agents.yaml'), 'sentinel: true\n');

    const result = await runSplit(['--source', fixturePath('agentchat-legacy.yaml'), '--dest', dir, '--force']);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'agents.yaml'), 'utf8')).toContain('claude-acp-sonnet');
  });

  test('dry run writes nothing', async () => {
    const dir = await makeTempDir();
    const result = await runSplit(['--source', fixturePath('agentchat-legacy.yaml'), '--dest', dir, '--dry-run']);

    expect(result.exitCode).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(result.stdout).toContain('would write');
  });

  test('migrates skill rosters from legacy keys', async () => {
    const dir = await makeTempDir();
    const source = join(dir, 'legacy.yaml');
    writeFileSync(
      source,
      [
        'agents:',
        '  - name: one',
        '    adapter: stdio-acp',
        'default_roles: {}',
        'review_personas:',
        '  - architect',
        'review_synthesizer: claude-acp-sonnet',
        'planner_personas:',
        '  - simplifier',
        'plan_synthesizer: claude-acp-sonnet',
        'providers: []',
        'notifications: {}',
        '',
      ].join('\n'),
    );

    const result = await runSplit(['--source', source, '--dest', dir, '--force']);

    expect(result.exitCode).toBe(0);
    const routing = RoutingConfigSchema.parse(YAML.parse(readFileSync(join(dir, 'routing.yaml'), 'utf8')));
    expect(routing.skill_rosters?.review.personas).toEqual(['architect']);
    expect(routing.skill_rosters?.review.synthesizer).toBe('claude-acp-sonnet');
  });

  test('missing source exits 2', async () => {
    const result = await runSplit(['--dest', '/tmp/nowhere']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('usage: penumbra config split');
  });
});
