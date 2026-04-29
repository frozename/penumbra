import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHooksInstallClaude, runHooksUninstallClaude } from '../../src/commands/hooks.js';

function tmpClaudeDir(initial?: any): string {
  const root = mkdtempSync(join(tmpdir(), 'penumbra-hooks-'));
  const claudeDir = join(root, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  if (initial !== undefined) writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(initial));
  return claudeDir;
}

describe('hooks install --claude', () => {
  it('installs penumbra statusline when no statusLine is configured', async () => {
    const claudeDir = tmpClaudeDir({});
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    const result = await runHooksInstallClaude({ claudeDir, scriptDir, force: false });
    expect(result.installed).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toContain('penumbra-claude-statusline');
    expect(existsSync(join(scriptDir, 'penumbra-claude-statusline'))).toBe(true);
  });

  it('is idempotent when penumbra is already installed', async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    const claudeDir = tmpClaudeDir({ statusLine: { command: join(scriptDir, 'penumbra-claude-statusline') } });
    const result = await runHooksInstallClaude({ claudeDir, scriptDir, force: false });
    expect(result.installed).toBe(false);
    expect(result.idempotent).toBe(true);
  });

  it('refuses to overwrite a third-party statusLine without --force', async () => {
    const claudeDir = tmpClaudeDir({ statusLine: { command: '/some/other/script.sh' } });
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    await expect(runHooksInstallClaude({ claudeDir, scriptDir, force: false }))
      .rejects.toThrow(/Refusing to overwrite|--force/);
  });

  it('with --force, backs up the existing statusLine and replaces it', async () => {
    const claudeDir = tmpClaudeDir({ statusLine: { command: '/oi/script.sh' } });
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    const result = await runHooksInstallClaude({ claudeDir, scriptDir, force: true });
    expect(result.installed).toBe(true);
    expect(result.backupPath).toBeDefined();
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toContain('penumbra-claude-statusline');
    expect(existsSync(result.backupPath!)).toBe(true);
  });
});

describe('hooks uninstall --claude', () => {
  it('removes penumbra statusLine but does not touch backup file', async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    const claudeDir = tmpClaudeDir({ statusLine: { command: join(scriptDir, 'penumbra-claude-statusline') } });
    const r = await runHooksUninstallClaude({ claudeDir, scriptDir });
    expect(r.removed).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine).toBeUndefined();
  });
});
