import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATUSLINE_SCRIPT = `#!/bin/bash
# Penumbra Claude Code statusLine integration
# Writes only to penumbra's own cache. Self-contained.
input=$(cat)
_rl=$(echo "$input" | jq -c '.rate_limits // empty' 2>/dev/null)
if [ -n "$_rl" ]; then
  tmpf=$(mktemp /tmp/penumbra-claude-rl.XXXXXX.json)
  printf '%s\\n' "$_rl" > "$tmpf"
  mv -f "$tmpf" /tmp/penumbra-claude-rl.json
fi
echo "$input" | jq -r '"[\\(.model.display_name // "Claude")] \\(.context_window.used_percentage // 0)% context"' 2>/dev/null
`;

export interface InstallClaudeOpts {
  claudeDir?: string;
  scriptDir?: string;
  force?: boolean;
}

export interface InstallClaudeResult {
  installed: boolean;
  idempotent?: boolean;
  scriptPath: string;
  backupPath?: string;
}

export async function runHooksInstallClaude(opts: InstallClaudeOpts = {}): Promise<InstallClaudeResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const scriptDir = opts.scriptDir ?? join(homedir(), '.penumbra', 'bin');
  const scriptPath = join(scriptDir, 'penumbra-claude-statusline');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(scriptPath, STATUSLINE_SCRIPT);
  chmodSync(scriptPath, 0o755);

  const settingsPath = join(claudeDir, 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const existing = settings.statusLine?.command;

  if (existing === scriptPath) {
    return { installed: false, idempotent: true, scriptPath };
  }
  let backupPath: string | undefined;
  if (existing && !opts.force) {
    throw new Error(`Existing statusLine \`${existing}\` detected. Refusing to overwrite. Run with --force-replace to replace.`);
  }
  if (existing && opts.force) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${settingsPath}.penumbra-backup-${stamp}`;
    writeFileSync(backupPath, JSON.stringify(settings, null, 2));
  }

  settings.statusLine = { type: 'command', command: scriptPath, padding: 2 };
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, scriptPath, backupPath };
}

export interface UninstallClaudeOpts {
  claudeDir?: string;
  scriptDir?: string;
}
export interface UninstallClaudeResult {
  removed: boolean;
}

export async function runHooksUninstallClaude(opts: UninstallClaudeOpts = {}): Promise<UninstallClaudeResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const scriptDir = opts.scriptDir ?? join(homedir(), '.penumbra', 'bin');
  const scriptPath = join(scriptDir, 'penumbra-claude-statusline');
  const settingsPath = join(claudeDir, 'settings.json');
  if (!existsSync(settingsPath)) return { removed: false };
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (settings.statusLine?.command !== scriptPath) return { removed: false };
  delete settings.statusLine;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { removed: true };
}

export async function runHooksStatus(_opts: { claudeDir?: string; scriptDir?: string } = {}): Promise<void> {
  // Minimal v1: print which hooks are installed.
}

export interface InstallGeminiOtelOpts {
  geminiDir?: string;
  portFile?: string;
}

export interface InstallGeminiOtelResult {
  installed: boolean;
  idempotent?: boolean;
  endpoint: string;
}

export async function runHooksInstallGeminiOtel(opts: InstallGeminiOtelOpts = {}): Promise<InstallGeminiOtelResult> {
  const geminiDir = opts.geminiDir ?? join(homedir(), '.gemini');
  const portFile = opts.portFile ?? '/tmp/penumbra-live/port';
  if (!existsSync(portFile)) {
    throw new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`);
  }
  const port = readFileSync(portFile, 'utf8').trim();
  const endpoint = `http://localhost:${port}`;

  mkdirSync(geminiDir, { recursive: true });
  const settingsPath = join(geminiDir, 'settings.json');
  const settings: Record<string, any> = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};

  const desired = {
    enabled: true,
    target: 'local',
    otlpProtocol: 'http',
    otlpEndpoint: endpoint,
    traces: false,
  };
  const current = settings.telemetry;
  const matches = current
    && current.enabled === desired.enabled
    && current.target === desired.target
    && current.otlpProtocol === desired.otlpProtocol
    && current.otlpEndpoint === desired.otlpEndpoint;
  if (matches) {
    return { installed: false, idempotent: true, endpoint };
  }
  settings.telemetry = { ...(current ?? {}), ...desired };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, endpoint };
}

export interface UninstallGeminiOtelOpts {
  geminiDir?: string;
}
export interface UninstallGeminiOtelResult {
  removed: boolean;
}

export async function runHooksUninstallGeminiOtel(opts: UninstallGeminiOtelOpts = {}): Promise<UninstallGeminiOtelResult> {
  const geminiDir = opts.geminiDir ?? join(homedir(), '.gemini');
  const settingsPath = join(geminiDir, 'settings.json');
  if (!existsSync(settingsPath)) return { removed: false };
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (!settings.telemetry) return { removed: false };
  delete settings.telemetry;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { removed: true };
}
