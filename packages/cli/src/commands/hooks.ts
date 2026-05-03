import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolveCliStorageRoot } from '../storage-root.js';

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
  const portFile = opts.portFile ?? join(resolveCliStorageRoot(), 'port');
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

const CODEX_OTEL_HEADER = '# penumbra: managed [otel] block — do not edit between markers';
const CODEX_OTEL_FOOTER = '# penumbra: end managed [otel] block';

export interface InstallCodexOtelOpts {
  codexDir?: string;
  portFile?: string;
}

export interface InstallCodexOtelResult {
  installed: boolean;
  idempotent?: boolean;
  endpoint: string;
}

function stripManagedBlock(content: string, header: string, footer: string): string {
  const lines = content.split('\n');
  const headerIdx = lines.indexOf(header);
  if (headerIdx < 0) return content;
  const footerIdx = lines.indexOf(footer, headerIdx);
  if (footerIdx < 0) return content;
  const before = lines.slice(0, headerIdx);
  const after = lines.slice(footerIdx + 1);
  while (before.length > 0 && before[before.length - 1] === '') before.pop();
  while (after.length > 0 && after[0] === '') after.shift();
  const parts = [...before, ...(before.length && after.length ? [''] : []), ...after];
  return parts.join('\n') + (parts.length ? '\n' : '');
}

export async function runHooksInstallCodexOtel(opts: InstallCodexOtelOpts = {}): Promise<InstallCodexOtelResult> {
  const codexDir = opts.codexDir ?? join(homedir(), '.codex');
  const portFile = opts.portFile ?? join(resolveCliStorageRoot(), 'port');
  if (!existsSync(portFile)) {
    throw new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`);
  }
  const port = readFileSync(portFile, 'utf8').trim();
  const endpoint = `http://localhost:${port}/v1/logs`;

  const block = [
    CODEX_OTEL_HEADER,
    '[otel]',
    'environment = "penumbra"',
    `exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "binary" } }`,
    CODEX_OTEL_FOOTER,
    '',
  ].join('\n');

  mkdirSync(codexDir, { recursive: true });
  const configPath = join(codexDir, 'config.toml');
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';

  const stripped = stripManagedBlock(current, CODEX_OTEL_HEADER, CODEX_OTEL_FOOTER);
  const hadBlock = stripped !== current;
  if (hadBlock && current.includes(`endpoint = "${endpoint}"`)) {
    return { installed: false, idempotent: true, endpoint };
  }
  if (!hadBlock && current.includes(CODEX_OTEL_HEADER) && current.includes(`endpoint = "${endpoint}"`)) {
    return { installed: false, idempotent: true, endpoint };
  }

  const sep = stripped === '' || stripped.endsWith('\n\n') ? '' : (stripped.endsWith('\n') ? '\n' : '\n\n');
  const next = stripped + sep + block;
  writeFileSync(configPath, next);
  return { installed: true, endpoint };
}

export interface UninstallCodexOtelOpts { codexDir?: string; }
export interface UninstallCodexOtelResult { removed: boolean; }

export async function runHooksUninstallCodexOtel(opts: UninstallCodexOtelOpts = {}): Promise<UninstallCodexOtelResult> {
  const codexDir = opts.codexDir ?? join(homedir(), '.codex');
  const configPath = join(codexDir, 'config.toml');
  if (!existsSync(configPath)) return { removed: false };
  const current = readFileSync(configPath, 'utf8');
  const stripped = stripManagedBlock(current, CODEX_OTEL_HEADER, CODEX_OTEL_FOOTER);
  if (stripped === current) return { removed: false };
  writeFileSync(configPath, stripped);
  return { removed: true };
}

const CLAUDE_OTEL_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
] as const;

export interface InstallClaudeOtelOpts {
  claudeDir?: string;
  portFile?: string;
}

export interface InstallClaudeOtelResult {
  installed: boolean;
  idempotent?: boolean;
  endpoint: string;
}

export async function runHooksInstallClaudeOtel(opts: InstallClaudeOtelOpts = {}): Promise<InstallClaudeOtelResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const portFile = opts.portFile ?? join(resolveCliStorageRoot(), 'port');
  if (!existsSync(portFile)) {
    throw new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`);
  }
  const port = readFileSync(portFile, 'utf8').trim();
  const endpoint = `http://localhost:${port}`;
  const desired: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  };

  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');
  const settings: Record<string, any> = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const currentEnv = settings.env ?? {};

  const matches = CLAUDE_OTEL_KEYS.every((k) => currentEnv[k] === desired[k]);
  if (matches) return { installed: false, idempotent: true, endpoint };

  settings.env = { ...currentEnv };
  for (const k of CLAUDE_OTEL_KEYS) settings.env[k] = desired[k]!;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, endpoint };
}

export interface UninstallClaudeOtelOpts { claudeDir?: string; }
export interface UninstallClaudeOtelResult { removed: boolean; }

export async function runHooksUninstallClaudeOtel(opts: UninstallClaudeOtelOpts = {}): Promise<UninstallClaudeOtelResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  if (!existsSync(settingsPath)) return { removed: false };
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (!settings.env) return { removed: false };
  let removed = false;
  for (const k of CLAUDE_OTEL_KEYS) {
    if (k in settings.env) { delete settings.env[k]; removed = true; }
  }
  if (Object.keys(settings.env).length === 0) delete settings.env;
  if (!removed) return { removed: false };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { removed: true };
}

// --- Claude Code memory hooks (UserPromptSubmit / PreToolUse / PostToolUse) ---
//
// Installs a per-event hook that POSTs the event to the daemon's /observations
// route via `penumbra hook claude-code`. Identifies pre-existing penumbra
// entries by command-pattern match (PENUMBRA_HOOK_RE) so the installer can
// update them in place without disturbing other tools' hooks living in the
// same event array.

const PENUMBRA_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
const PENUMBRA_HOOK_RE = /penumbra(?:\.ts)?\s+hook\s+claude-code/;

function isPenumbraHookCommand(cmd: unknown): cmd is string {
  return typeof cmd === 'string' && PENUMBRA_HOOK_RE.test(cmd);
}

function defaultPenumbraBinPath(): string {
  return fileURLToPath(new URL('../../bin/penumbra.ts', import.meta.url));
}

export interface InstallClaudeMemoryOpts {
  claudeDir?: string;
  storageRoot?: string;
  binPath?: string;
  /** Skip the daemon-running guard. Useful for tests; not exposed via CLI. */
  skipDaemonCheck?: boolean;
}

export interface InstallClaudeMemoryResult {
  installed: boolean;
  idempotent?: boolean;
  events: string[];
  command: string;
  storageRoot: string;
}

export async function runHooksInstallClaudeMemory(opts: InstallClaudeMemoryOpts = {}): Promise<InstallClaudeMemoryResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const storageRoot = opts.storageRoot ?? resolveCliStorageRoot();
  const binPath = opts.binPath ?? defaultPenumbraBinPath();

  if (!opts.skipDaemonCheck) {
    const portFile = join(storageRoot, 'port');
    if (!existsSync(portFile)) {
      throw new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`);
    }
  }

  const command = `PENUMBRA_STORAGE_ROOT=${storageRoot} bun ${binPath} hook claude-code`;

  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');
  const settings: Record<string, any> = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, 'utf8'))
    : {};
  settings.hooks ??= {};

  let changed = false;
  for (const event of PENUMBRA_HOOK_EVENTS) {
    const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    let foundPenumbra = false;
    for (const entry of entries) {
      const hooks = entry?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (isPenumbraHookCommand(hook?.command)) {
          foundPenumbra = true;
          if (hook.command !== command) {
            hook.command = command;
            changed = true;
          }
        }
      }
    }
    if (!foundPenumbra) {
      entries.push({ matcher: '*', hooks: [{ type: 'command', command }] });
      settings.hooks[event] = entries;
      changed = true;
    }
  }

  if (!changed) {
    return { installed: false, idempotent: true, events: [...PENUMBRA_HOOK_EVENTS], command, storageRoot };
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, events: [...PENUMBRA_HOOK_EVENTS], command, storageRoot };
}

export interface UninstallClaudeMemoryOpts {
  claudeDir?: string;
}

export interface UninstallClaudeMemoryResult {
  removed: boolean;
  events: string[];
}

export async function runHooksUninstallClaudeMemory(opts: UninstallClaudeMemoryOpts = {}): Promise<UninstallClaudeMemoryResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  if (!existsSync(settingsPath)) return { removed: false, events: [] };
  const settings: Record<string, any> = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (!settings.hooks) return { removed: false, events: [] };

  const removedFrom: string[] = [];
  for (const event of PENUMBRA_HOOK_EVENTS) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    let touched = false;
    const remaining = entries
      .map((entry: any) => {
        const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
        const filtered = hooks.filter((h: any) => !isPenumbraHookCommand(h?.command));
        if (filtered.length !== hooks.length) touched = true;
        return { ...entry, hooks: filtered };
      })
      // Drop entries that became empty after stripping our hooks.
      .filter((entry: any) => Array.isArray(entry?.hooks) && entry.hooks.length > 0);
    if (touched) {
      removedFrom.push(event);
      if (remaining.length > 0) settings.hooks[event] = remaining;
      else delete settings.hooks[event];
    }
  }
  if (removedFrom.length === 0) return { removed: false, events: [] };
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { removed: true, events: removedFrom };
}
