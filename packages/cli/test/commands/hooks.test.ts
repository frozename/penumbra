import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHooksInstallClaude, runHooksUninstallClaude, runHooksInstallGeminiOtel, runHooksUninstallGeminiOtel } from '../../src/commands/hooks.js';

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

function makeFakeHome(): { home: string; geminiDir: string; portFile: string } {
  const home = mkdtempSync(join(tmpdir(), 'penumbra-hooks-'));
  const geminiDir = join(home, '.gemini');
  mkdirSync(geminiDir, { recursive: true });
  const portFile = join(home, 'penumbra-port');
  writeFileSync(portFile, '51390');
  return { home, geminiDir, portFile };
}

describe('runHooksInstallGeminiOtel', () => {
  it('writes telemetry block into ~/.gemini/settings.json with the daemon port', async () => {
    const { geminiDir, portFile } = makeFakeHome();
    const r = await runHooksInstallGeminiOtel({ geminiDir, portFile });
    expect(r.installed).toBe(true);
    const settings = JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf8'));
    expect(settings.telemetry).toMatchObject({
      enabled: true,
      target: 'local',
      otlpProtocol: 'http',
      otlpEndpoint: 'http://localhost:51390',
    });
  });

  it('preserves existing settings.json keys', async () => {
    const { geminiDir, portFile } = makeFakeHome();
    writeFileSync(join(geminiDir, 'settings.json'), JSON.stringify({ theme: 'Dark', selectedAuthType: 'oauth-personal' }, null, 2));
    await runHooksInstallGeminiOtel({ geminiDir, portFile });
    const settings = JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf8'));
    expect(settings.theme).toBe('Dark');
    expect(settings.selectedAuthType).toBe('oauth-personal');
    expect(settings.telemetry?.otlpEndpoint).toBe('http://localhost:51390');
  });

  it('is idempotent when settings already match', async () => {
    const { geminiDir, portFile } = makeFakeHome();
    await runHooksInstallGeminiOtel({ geminiDir, portFile });
    const r2 = await runHooksInstallGeminiOtel({ geminiDir, portFile });
    expect(r2.idempotent).toBe(true);
    expect(r2.installed).toBe(false);
  });

  it('throws when port file is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'penumbra-hooks-'));
    const geminiDir = join(home, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    await expect(runHooksInstallGeminiOtel({ geminiDir, portFile: join(home, 'missing') })).rejects.toThrow(/port/i);
  });
});

describe('runHooksUninstallGeminiOtel', () => {
  it('removes the telemetry block we wrote', async () => {
    const { geminiDir, portFile } = makeFakeHome();
    await runHooksInstallGeminiOtel({ geminiDir, portFile });
    const r = await runHooksUninstallGeminiOtel({ geminiDir });
    expect(r.removed).toBe(true);
    const settings = JSON.parse(readFileSync(join(geminiDir, 'settings.json'), 'utf8'));
    expect(settings.telemetry).toBeUndefined();
  });

  it('returns removed=false when no telemetry block exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'penumbra-hooks-'));
    const geminiDir = join(home, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(join(geminiDir, 'settings.json'), JSON.stringify({ theme: 'Dark' }));
    const r = await runHooksUninstallGeminiOtel({ geminiDir });
    expect(r.removed).toBe(false);
  });
});
