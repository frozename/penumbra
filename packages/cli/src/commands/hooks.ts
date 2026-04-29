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
