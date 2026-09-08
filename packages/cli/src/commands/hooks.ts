import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCliStorageRoot } from "../storage-root.js";

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

type JsonObject = Record<string, unknown>;

function readJsonFile(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as JsonObject;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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

export async function runHooksInstallClaude(
  opts: InstallClaudeOpts = {},
): Promise<InstallClaudeResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const scriptDir = opts.scriptDir ?? join(homedir(), ".penumbra", "bin");
  const scriptPath = join(scriptDir, "penumbra-claude-statusline");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(scriptPath, STATUSLINE_SCRIPT);
  chmodSync(scriptPath, 0o755);

  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJsonFile(settingsPath);
  const statusLine = asObject(settings.statusLine);
  const existing = typeof statusLine?.command === "string" ? statusLine.command : undefined;

  if (existing === scriptPath) {
    return { installed: false, idempotent: true, scriptPath };
  }
  let backupPath: string | undefined;
  if (existing && !opts.force) {
    throw new Error(
      `Existing statusLine \`${existing}\` detected. Refusing to overwrite. Run with --force-replace to replace.`,
    );
  }
  if (existing && opts.force) {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    backupPath = `${settingsPath}.penumbra-backup-${stamp}`;
    writeFileSync(backupPath, JSON.stringify(settings, null, 2));
  }

  settings.statusLine = { type: "command", command: scriptPath, padding: 2 };
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  try {
    const { buildRegistry, writeSlashCommands } = await import("@penumbra/workflows");
    const reg = await buildRegistry({
      playbooksDir: join(process.cwd(), "plugin/playbooks"),
      workflowsDir: join(process.cwd(), "plugin/workflows"),
    });
    const written = writeSlashCommands(reg, join(claudeDir, "commands"));
    process.stdout.write(
      `wrote ${String(written.length)} slash commands to ${join(claudeDir, "commands")}/\n`,
    );
  } catch (err) {
    process.stderr.write(`skipped slash-bridge install: ${(err as Error).message}\n`);
  }

  return { installed: true, scriptPath, backupPath };
}

export interface UninstallClaudeOpts {
  claudeDir?: string;
  scriptDir?: string;
}
export interface UninstallClaudeResult {
  removed: boolean;
}

export function runHooksUninstallClaude(
  opts: UninstallClaudeOpts = {},
): Promise<UninstallClaudeResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const scriptDir = opts.scriptDir ?? join(homedir(), ".penumbra", "bin");
  const scriptPath = join(scriptDir, "penumbra-claude-statusline");
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) return Promise.resolve({ removed: false });
  const settings = readJsonFile(settingsPath);
  const statusLine = asObject(settings.statusLine);
  if (statusLine?.command !== scriptPath) return Promise.resolve({ removed: false });
  delete settings.statusLine;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return Promise.resolve({ removed: true });
}

export function runHooksStatus(
  _opts: { claudeDir?: string; scriptDir?: string } = {},
): Promise<void> {
  // Minimal v1: print which hooks are installed.
  return Promise.resolve();
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

export function runHooksInstallGeminiOtel(
  opts: InstallGeminiOtelOpts = {},
): Promise<InstallGeminiOtelResult> {
  const geminiDir = opts.geminiDir ?? join(homedir(), ".gemini");
  const portFile = opts.portFile ?? join(resolveCliStorageRoot(), "port");
  if (!existsSync(portFile)) {
    return Promise.reject(
      new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`),
    );
  }
  const port = readFileSync(portFile, "utf8").trim();
  const endpoint = `http://localhost:${port}`;

  mkdirSync(geminiDir, { recursive: true });
  const settingsPath = join(geminiDir, "settings.json");
  const settings = readJsonFile(settingsPath);

  const desired = {
    enabled: true,
    target: "local",
    otlpProtocol: "http",
    otlpEndpoint: endpoint,
    traces: false,
  };
  const current = asObject(settings.telemetry);
  const matches =
    current?.enabled === desired.enabled &&
    current.target === desired.target &&
    current.otlpProtocol === desired.otlpProtocol &&
    current.otlpEndpoint === desired.otlpEndpoint;
  if (matches) {
    return Promise.resolve({ installed: false, idempotent: true, endpoint });
  }
  settings.telemetry = { ...(current ?? {}), ...desired };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return Promise.resolve({ installed: true, endpoint });
}

export interface UninstallGeminiOtelOpts {
  geminiDir?: string;
}
export interface UninstallGeminiOtelResult {
  removed: boolean;
}

export function runHooksUninstallGeminiOtel(
  opts: UninstallGeminiOtelOpts = {},
): Promise<UninstallGeminiOtelResult> {
  const geminiDir = opts.geminiDir ?? join(homedir(), ".gemini");
  const settingsPath = join(geminiDir, "settings.json");
  if (!existsSync(settingsPath)) return Promise.resolve({ removed: false });
  const settings = readJsonFile(settingsPath);
  if (!settings.telemetry) return Promise.resolve({ removed: false });
  delete settings.telemetry;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return Promise.resolve({ removed: true });
}

const CODEX_OTEL_HEADER = "# penumbra: managed [otel] block — do not edit between markers";
const CODEX_OTEL_FOOTER = "# penumbra: end managed [otel] block";

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
  const lines = content.split("\n");
  const headerIdx = lines.indexOf(header);
  if (headerIdx < 0) return content;
  const footerIdx = lines.indexOf(footer, headerIdx);
  if (footerIdx < 0) return content;
  const before = lines.slice(0, headerIdx);
  const after = lines.slice(footerIdx + 1);
  while (before.length > 0 && before[before.length - 1] === "") before.pop();
  while (after.length > 0 && after[0] === "") after.shift();
  const parts = [...before, ...(before.length && after.length ? [""] : []), ...after];
  return parts.join("\n") + (parts.length ? "\n" : "");
}

// Extract the text BETWEEN the managed header and footer markers (exclusive). Returns
// null when no complete block is present. The version-idempotency check must read the
// marker from inside the managed block, not the whole file — a user writing the version
// comment outside the block must not let a stale block survive a needed rewrite.
function extractManagedBlock(content: string, header: string, footer: string): string | null {
  const lines = content.split("\n");
  const headerIdx = lines.indexOf(header);
  if (headerIdx < 0) return null;
  const footerIdx = lines.indexOf(footer, headerIdx);
  if (footerIdx < 0) return null;
  return lines.slice(headerIdx + 1, footerIdx).join("\n");
}

export function runHooksInstallCodexOtel(
  opts: InstallCodexOtelOpts = {},
): Promise<InstallCodexOtelResult> {
  const codexDir = opts.codexDir ?? join(homedir(), ".codex");
  const portFile = opts.portFile ?? join(resolveCliStorageRoot(), "port");
  if (!existsSync(portFile)) {
    return Promise.reject(
      new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`),
    );
  }
  const port = readFileSync(portFile, "utf8").trim();
  const endpoint = `http://localhost:${port}/v1/logs`;

  const block = [
    CODEX_OTEL_HEADER,
    "[otel]",
    'environment = "penumbra"',
    `exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "binary" } }`,
    CODEX_OTEL_FOOTER,
    "",
  ].join("\n");

  mkdirSync(codexDir, { recursive: true });
  const configPath = join(codexDir, "config.toml");
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

  const stripped = stripManagedBlock(current, CODEX_OTEL_HEADER, CODEX_OTEL_FOOTER);
  const hadBlock = stripped !== current;
  if (hadBlock && current.includes(`endpoint = "${endpoint}"`)) {
    return Promise.resolve({ installed: false, idempotent: true, endpoint });
  }
  if (
    !hadBlock &&
    current.includes(CODEX_OTEL_HEADER) &&
    current.includes(`endpoint = "${endpoint}"`)
  ) {
    return Promise.resolve({ installed: false, idempotent: true, endpoint });
  }

  const sep =
    stripped === "" || stripped.endsWith("\n\n") ? "" : stripped.endsWith("\n") ? "\n" : "\n\n";
  const next = stripped + sep + block;
  writeFileSync(configPath, next);
  return Promise.resolve({ installed: true, endpoint });
}

export interface UninstallCodexOtelOpts {
  codexDir?: string;
}
export interface UninstallCodexOtelResult {
  removed: boolean;
}

export function runHooksUninstallCodexOtel(
  opts: UninstallCodexOtelOpts = {},
): Promise<UninstallCodexOtelResult> {
  const codexDir = opts.codexDir ?? join(homedir(), ".codex");
  const configPath = join(codexDir, "config.toml");
  if (!existsSync(configPath)) return Promise.resolve({ removed: false });
  const current = readFileSync(configPath, "utf8");
  const stripped = stripManagedBlock(current, CODEX_OTEL_HEADER, CODEX_OTEL_FOOTER);
  if (stripped === current) return Promise.resolve({ removed: false });
  writeFileSync(configPath, stripped);
  return Promise.resolve({ removed: true });
}

// --- Claude Code CLAUDE.md dispatch-discipline managed block ---

const CLAUDE_MD_HEADER =
  "<!-- penumbra: managed [dispatch-discipline] block — do not edit between markers -->";
const CLAUDE_MD_FOOTER = "<!-- penumbra: end managed [dispatch-discipline] block -->";

// Bump this when CLAUDE_MD_BODY changes so an installed-but-stale block is rewritten.
const CLAUDE_MD_VERSION = "v3";

const CLAUDE_MD_BODY = [
  CLAUDE_MD_HEADER,
  `<!-- ${CLAUDE_MD_VERSION} -->`,
  "## Dispatch discipline (penumbra)",
  "",
  "Dispatch-by-default for substantive work. A *list of edits*, a *multi-file change*, or a *repeated edit shape* is dispatchable — author/run a workflow (`workflow_run` / a CC Workflow: penumbra-fanout, penumbra-fix-until-green, penumbra-fleet-verify, penumbra-swarm) or a `chain_start`, rather than hand-implementing solo.",
  "",
  "Solo is the *exception*, not the default. Hand-implement only for a single trivial edit, a daemon-won't-boot fix, or scaffolding an agent will build on — and log a one-line `SOLO-OK: <reason>` when you do.",
  "",
  "Serial diagnosis is exempt (read, grep, run, reason) — but the fix-list it produces is dispatchable; dispatch it.",
  "",
  "Under **ultracode**, workflow-first for *every* substantive task: token cost is not a constraint. The automatic post-tool-use hook nudge (dispatch-drift-guard) is binding — when it fires, either dispatch the remaining work-list or reply with one line `SOLO-OK: <reason>` before continuing.",
  "",
  "## Registrar discipline (penumbra)",
  "",
  "**A merge is not finished until the registrar phase transition is written.** Pair them in the same turn, the way a land is paired with its verification. Session close is too late — that is exactly when the ledger rots, and a stale entry causes the next session to re-dispatch shipped work or block on an already-satisfied dependency.",
  "",
  "A phase `status` records what someone last WROTE, not what merged. Verify against the substrate before acting on it: `gh pr view <n> --json state,mergedAt,isDraft`. Distinguish MERGED from COMPLETE — one of six tasks merged is `active`, not `complete`.",
  "",
  "Read with `registrar_list` (cheap: status, rollup, phase_progress). Reach for `registrar_status` only when you need the event bodies — it returns every one in full and truncates past ~20k tokens on a mature entry, costing you the most recent events. Prefer the latest event on any question; later ones routinely correct earlier ones.",
  CLAUDE_MD_FOOTER,
  "",
].join("\n");

export interface InstallClaudeMdOpts {
  claudeDir?: string;
}

export interface InstallClaudeMdResult {
  installed: boolean;
  idempotent?: boolean;
  path: string;
}

export function runHooksInstallClaudeMd(
  opts: InstallClaudeMdOpts = {},
): Promise<InstallClaudeMdResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const mdPath = join(claudeDir, "CLAUDE.md");
  const current = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";

  const stripped = stripManagedBlock(current, CLAUDE_MD_HEADER, CLAUDE_MD_FOOTER);
  const hadBlock = stripped !== current;
  const blockBody = extractManagedBlock(current, CLAUDE_MD_HEADER, CLAUDE_MD_FOOTER);
  if (hadBlock && blockBody?.includes(`<!-- ${CLAUDE_MD_VERSION} -->`)) {
    return Promise.resolve({ installed: false, idempotent: true, path: mdPath });
  }

  const sep =
    stripped === "" || stripped.endsWith("\n\n") ? "" : stripped.endsWith("\n") ? "\n" : "\n\n";
  const next = stripped + sep + CLAUDE_MD_BODY;
  writeFileSync(mdPath, next);
  return Promise.resolve({ installed: true, path: mdPath });
}

export interface UninstallClaudeMdOpts {
  claudeDir?: string;
}
export interface UninstallClaudeMdResult {
  removed: boolean;
}

export function runHooksUninstallClaudeMd(
  opts: UninstallClaudeMdOpts = {},
): Promise<UninstallClaudeMdResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const mdPath = join(claudeDir, "CLAUDE.md");
  if (!existsSync(mdPath)) return Promise.resolve({ removed: false });
  const current = readFileSync(mdPath, "utf8");
  const stripped = stripManagedBlock(current, CLAUDE_MD_HEADER, CLAUDE_MD_FOOTER);
  if (stripped === current) return Promise.resolve({ removed: false });
  writeFileSync(mdPath, stripped);
  return Promise.resolve({ removed: true });
}

const CLAUDE_OTEL_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
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

export function runHooksInstallClaudeOtel(
  opts: InstallClaudeOtelOpts = {},
): Promise<InstallClaudeOtelResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const portFile = opts.portFile ?? join(resolveCliStorageRoot(), "port");
  if (!existsSync(portFile)) {
    return Promise.reject(
      new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`),
    );
  }
  const port = readFileSync(portFile, "utf8").trim();
  const endpoint = `http://localhost:${port}`;
  const desired: Record<(typeof CLAUDE_OTEL_KEYS)[number], string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  };

  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJsonFile(settingsPath);
  const currentEnv = asObject(settings.env) ?? {};

  const matches = CLAUDE_OTEL_KEYS.every((k) => currentEnv[k] === desired[k]);
  if (matches) return Promise.resolve({ installed: false, idempotent: true, endpoint });

  const nextEnv: JsonObject = { ...currentEnv };
  for (const k of CLAUDE_OTEL_KEYS) nextEnv[k] = desired[k];
  settings.env = nextEnv;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return Promise.resolve({ installed: true, endpoint });
}

export interface UninstallClaudeOtelOpts {
  claudeDir?: string;
}
export interface UninstallClaudeOtelResult {
  removed: boolean;
}

export function runHooksUninstallClaudeOtel(
  opts: UninstallClaudeOtelOpts = {},
): Promise<UninstallClaudeOtelResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) return Promise.resolve({ removed: false });
  const settings = readJsonFile(settingsPath);
  const env = asObject(settings.env);
  if (!env) return Promise.resolve({ removed: false });
  const otelKeys = new Set<string>(CLAUDE_OTEL_KEYS);
  let removed = false;
  const remaining: JsonObject = {};
  for (const [k, v] of Object.entries(env)) {
    if (otelKeys.has(k)) {
      removed = true;
      continue;
    }
    remaining[k] = v;
  }
  if (Object.keys(remaining).length === 0) delete settings.env;
  else settings.env = remaining;
  if (!removed) return Promise.resolve({ removed: false });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return Promise.resolve({ removed: true });
}

// --- Claude Code memory hooks (UserPromptSubmit / PreToolUse / PostToolUse) ---

export const PENUMBRA_HOOK_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "PreCompact",
  "Stop",
  "SessionEnd",
] as const;
const PENUMBRA_HOOK_RE = /penumbra(?:\.ts)?'?\s+hook\s+claude-code/;

interface HookCommand {
  type?: unknown;
  command?: unknown;
}

interface HookEntry {
  matcher?: unknown;
  hooks?: unknown;
}

function isPenumbraHookCommand(cmd: unknown): cmd is string {
  return typeof cmd === "string" && PENUMBRA_HOOK_RE.test(cmd);
}

function defaultPenumbraBinPath(): string {
  return fileURLToPath(new URL("../../bin/penumbra.ts", import.meta.url));
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

/** Wrap a value in single quotes, escaping any embedded single quotes. */
function shellQuote(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

function upsertPenumbraHookForEvent(hooksMap: JsonObject, event: string, command: string): boolean {
  const entriesRaw = asArray(hooksMap[event]);
  const entries = entriesRaw.filter((entry): entry is HookEntry => asObject(entry) !== null);
  let foundPenumbra = false;
  let changed = false;
  for (const entry of entries) {
    const hooks = asArray(entry.hooks).filter((h): h is HookCommand => asObject(h) !== null);
    for (const hook of hooks) {
      if (isPenumbraHookCommand(hook.command)) {
        foundPenumbra = true;
        if (hook.command !== command) {
          hook.command = command;
          changed = true;
        }
      }
    }
  }
  if (!foundPenumbra) {
    entries.push({ matcher: "*", hooks: [{ type: "command", command }] });
    hooksMap[event] = entries;
    changed = true;
  }
  return changed;
}

export function runHooksInstallClaudeMemory(
  opts: InstallClaudeMemoryOpts = {},
): Promise<InstallClaudeMemoryResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const storageRoot = opts.storageRoot ?? resolveCliStorageRoot();
  const binPath = opts.binPath ?? defaultPenumbraBinPath();

  if (!opts.skipDaemonCheck) {
    const portFile = join(storageRoot, "port");
    if (!existsSync(portFile)) {
      return Promise.reject(
        new Error(`penumbra hooks: daemon port file ${portFile} not found. Is the daemon running?`),
      );
    }
  }

  const command = `PENUMBRA_STORAGE_ROOT=${shellQuote(storageRoot)} bun ${shellQuote(binPath)} hook claude-code`;

  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJsonFile(settingsPath);
  const hooksMap = asObject(settings.hooks) ?? {};
  settings.hooks = hooksMap;

  let changed = false;
  for (const event of PENUMBRA_HOOK_EVENTS) {
    if (upsertPenumbraHookForEvent(hooksMap, event, command)) changed = true;
  }

  if (!changed) {
    return Promise.resolve({
      installed: false,
      idempotent: true,
      events: [...PENUMBRA_HOOK_EVENTS],
      command,
      storageRoot,
    });
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return Promise.resolve({
    installed: true,
    events: [...PENUMBRA_HOOK_EVENTS],
    command,
    storageRoot,
  });
}

export interface UninstallClaudeMemoryOpts {
  claudeDir?: string;
}

export interface UninstallClaudeMemoryResult {
  removed: boolean;
  events: string[];
}

function filterPenumbraHooksFromEvent(hooksMap: JsonObject, event: string): boolean {
  const entriesRaw = asArray(hooksMap[event]);
  if (entriesRaw.length === 0) return false;
  let touched = false;
  const remaining: HookEntry[] = [];
  for (const rawEntry of entriesRaw) {
    const entry = asObject(rawEntry);
    if (!entry) continue;
    const hooks = asArray(entry.hooks).filter((h): h is HookCommand => asObject(h) !== null);
    const filtered = hooks.filter((h) => !isPenumbraHookCommand(h.command));
    if (filtered.length !== hooks.length) touched = true;
    if (filtered.length > 0) remaining.push({ ...entry, hooks: filtered });
  }
  if (!touched) return false;
  if (remaining.length > 0) hooksMap[event] = remaining;
  else hooksMap[event] = undefined;
  return true;
}

export function runHooksUninstallClaudeMemory(
  opts: UninstallClaudeMemoryOpts = {},
): Promise<UninstallClaudeMemoryResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) return Promise.resolve({ removed: false, events: [] });
  const settings = readJsonFile(settingsPath);
  const hooksMap = asObject(settings.hooks);
  if (!hooksMap) return Promise.resolve({ removed: false, events: [] });

  const removedFrom: string[] = [];
  for (const event of PENUMBRA_HOOK_EVENTS) {
    if (filterPenumbraHooksFromEvent(hooksMap, event)) removedFrom.push(event);
  }
  if (removedFrom.length === 0) return Promise.resolve({ removed: false, events: [] });
  if (Object.keys(hooksMap).length === 0) delete settings.hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return Promise.resolve({ removed: true, events: removedFrom });
}
