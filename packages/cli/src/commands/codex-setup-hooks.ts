import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";

import { qualifyCodexHookReport } from "./codex-hook-capabilities.js";

export type CodexHookCapabilityState = "supported" | "unavailable" | "unknown";
export type CodexHookSetupState = "installed" | "absent" | "unavailable" | "conflict";

export type CodexHookHandler = {
  type: "command";
  command: string;
  timeout: number;
};

export type CodexHookGroup = {
  matcher?: string;
  hooks: CodexHookHandler[];
};

export type CodexHookMap = Record<string, CodexHookGroup[]>;

export interface CodexHookPlan {
  state: "installed" | "unavailable";
  detail: string;
  hooks: CodexHookMap;
}

export interface CodexHookOwnership {
  configPath: string;
  commandPrefix: string;
  entries: { event: string; hash: string }[];
}

export function isValidCodexHookOwnership(value: unknown, configPath: string): boolean {
  if (!isRecord(value)) return false;
  if (
    value.configPath !== configPath ||
    !nonBlank(value.commandPrefix) ||
    !Array.isArray(value.entries)
  )
    return false;
  return value.entries.every(
    (entry) =>
      isRecord(entry) &&
      nonBlank(entry.event) &&
      typeof entry.hash === "string" &&
      /^[a-f0-9]{64}$/.test(entry.hash),
  );
}

export interface PreparedCodexHooks {
  state: CodexHookSetupState;
  detail: string;
  current: string | null;
  next: string | null;
  ownership?: CodexHookOwnership;
}

export interface CodexHookSetupContext {
  codexDir: string;
  packageDir: string;
  storageRoot: string;
  hookCapabilities?: unknown;
  observedCodexBuild?: string;
}

export function isValidCodexHookOwnershipForSetup(
  value: unknown,
  opts: CodexHookSetupContext,
): boolean {
  return value === undefined || isValidCodexHookOwnership(value, setupConfigPath(opts));
}

type HookConfig = { hooks: Record<string, unknown[]>; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildCodexHookPlan(opts: {
  manifest: unknown;
  command: string;
  observedBuild?: string;
}): CodexHookPlan {
  if (opts.manifest === undefined || opts.manifest === null) {
    return {
      state: "unavailable",
      detail: "no probe-qualified CLI hook events are available",
      hooks: {},
    };
  }
  const qualification = qualifyCodexHookReport(opts.manifest, opts.observedBuild);
  const hooks: CodexHookMap = {};
  for (const qualified of qualification.hooks) {
    const current = hooks[qualified.event] ?? [];
    hooks[qualified.event] = [
      ...current,
      {
        ...(qualified.matcher ? { matcher: qualified.matcher } : {}),
        hooks: [{ type: "command", command: opts.command, timeout: 2 }],
      },
    ];
  }
  const count = Object.values(hooks).reduce((total, groups) => total + groups.length, 0);
  return count === 0
    ? {
        state: "unavailable",
        detail: qualification.detail,
        hooks,
      }
    : {
        state: "installed",
        detail: qualification.detail,
        hooks,
      };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function codexHookCommand(opts: {
  runtimePath: string;
  cliEntrypoint: string;
  storageRoot: string;
}): string {
  return [
    shellQuote(opts.runtimePath),
    shellQuote(opts.cliEntrypoint),
    "hook",
    "codex",
    "--storage-root",
    shellQuote(opts.storageRoot),
  ].join(" ");
}

export function readCodexHookPlan(opts: {
  manifest: unknown;
  command: string;
  observedBuild?: string;
}): CodexHookPlan {
  return buildCodexHookPlan(opts);
}

function parseConfig(content: string | null): HookConfig {
  if (content === null) return { hooks: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`malformed Codex hooks.json: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error("Codex hooks.json must contain an object");
  if (parsed.hooks === undefined) return { ...parsed, hooks: {} };
  if (!isRecord(parsed.hooks)) throw new Error("Codex hooks.json hooks must contain an object");
  for (const groups of Object.values(parsed.hooks)) {
    if (!Array.isArray(groups)) throw new Error("Codex hooks.json event groups must be arrays");
  }
  return { ...parsed, hooks: { ...parsed.hooks } } as HookConfig;
}

function serializeConfig(config: HookConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function groupCommand(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return null;
  for (const handler of value.hooks) {
    if (isRecord(handler) && handler.type === "command" && nonBlank(handler.command)) {
      return handler.command;
    }
  }
  return null;
}

function previousHash(previous: CodexHookOwnership, event: string, value: unknown): boolean {
  const candidate = hash(value);
  return previous.entries.some((entry) => entry.event === event && entry.hash === candidate);
}

function assertNoChangedOwnedGroups(config: HookConfig, previous?: CodexHookOwnership): void {
  if (!previous) return;
  for (const [event, groups] of Object.entries(config.hooks)) {
    for (const group of groups) {
      const command = groupCommand(group);
      if (command?.startsWith(previous.commandPrefix) && !previousHash(previous, event, group)) {
        throw new Error(`owned Codex hook was modified: ${event}`);
      }
    }
  }
}

function stripOwned(config: HookConfig, previous?: CodexHookOwnership): HookConfig {
  if (!previous) return config;
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(config.hooks)) {
    const kept = groups.filter((group) => !previousHash(previous, event, group));
    if (kept.length > 0) hooks[event] = kept;
  }
  return { ...config, hooks };
}

function appendPlan(config: HookConfig, plan: CodexHookPlan): HookConfig {
  const hooks = { ...config.hooks };
  for (const [event, groups] of Object.entries(plan.hooks)) {
    const current = hooks[event] ?? [];
    const hashes = new Set(current.map((group) => hash(group)));
    hooks[event] = [...current, ...groups.filter((group) => !hashes.has(hash(group)))];
  }
  return { ...config, hooks };
}

function ownershipFor(
  configPath: string,
  command: string,
  plan: CodexHookPlan,
): CodexHookOwnership | undefined {
  const entries = Object.entries(plan.hooks).flatMap(([event, groups]) =>
    groups.map((group) => ({ event, hash: hash(group) })),
  );
  return entries.length === 0 ? undefined : { configPath, commandPrefix: command, entries };
}

export function prepareCodexHooks(opts: {
  configPath: string;
  current: string | null;
  previous?: CodexHookOwnership;
  plan: CodexHookPlan;
  command: string;
}): PreparedCodexHooks {
  if (opts.plan.state === "unavailable" && !opts.previous) {
    return {
      state: "unavailable",
      detail: opts.plan.detail,
      current: opts.current,
      next: opts.current,
    };
  }
  const parsed = parseConfig(opts.current);
  assertNoChangedOwnedGroups(parsed, opts.previous);
  const nextConfig = appendPlan(stripOwned(parsed, opts.previous), opts.plan);
  const next = serializeConfig(nextConfig);
  return {
    state: opts.plan.state,
    detail: opts.plan.detail,
    current: opts.current,
    next,
    ...(ownershipFor(opts.configPath, opts.command, opts.plan)
      ? { ownership: ownershipFor(opts.configPath, opts.command, opts.plan) }
      : {}),
  };
}

export function inspectCodexHooks(opts: {
  current: string | null;
  previous?: CodexHookOwnership;
  plan: CodexHookPlan;
}): { state: CodexHookSetupState; detail: string } {
  const config = parseConfig(opts.current);
  try {
    assertNoChangedOwnedGroups(config, opts.previous);
  } catch (error) {
    return { state: "conflict", detail: (error as Error).message };
  }
  if (!opts.previous || opts.previous.entries.length === 0) {
    return opts.plan.state === "unavailable"
      ? { state: "unavailable", detail: opts.plan.detail }
      : { state: "absent", detail: "owned Codex hooks are absent" };
  }
  const complete = opts.previous.entries.every(({ event, hash: expected }) =>
    (config.hooks[event] ?? []).some((group) => hash(group) === expected),
  );
  return complete
    ? {
        state: "installed",
        detail: `${String(opts.previous.entries.length)} owned Codex hooks match their recorded hashes`,
      }
    : { state: "absent", detail: "one or more owned Codex hooks are missing" };
}

export function removeCodexHooks(opts: { current: string | null; previous?: CodexHookOwnership }): {
  state: CodexHookSetupState;
  detail: string;
  next: string | null;
  changed: boolean;
} {
  const config = parseConfig(opts.current);
  try {
    assertNoChangedOwnedGroups(config, opts.previous);
  } catch (error) {
    return {
      state: "conflict",
      detail: (error as Error).message,
      next: opts.current,
      changed: false,
    };
  }
  if (!opts.previous || opts.previous.entries.length === 0) {
    return {
      state: "absent",
      detail: "owned Codex hooks are absent",
      next: opts.current,
      changed: false,
    };
  }
  const stripped = stripOwned(config, opts.previous);
  const onlyEmptyHooks =
    Object.keys(stripped).every((key) => key === "hooks") &&
    Object.keys(stripped.hooks).length === 0;
  const next = onlyEmptyHooks ? null : serializeConfig(stripped);
  return {
    state: "absent",
    detail: "owned Codex hooks were removed",
    next,
    changed: next !== opts.current,
  };
}

function setupConfigPath(opts: CodexHookSetupContext): string {
  return join(opts.codexDir, "hooks.json");
}

function assertPathComponent(
  current: string,
  path: string,
  requireExisting: boolean,
  isLeaf: boolean,
): boolean {
  const stat = lstatSync(current, { throwIfNoEntry: false });
  if (!stat) {
    if (requireExisting) throw new Error(`required path is absent: ${path}`);
    return false;
  }
  if (stat.isSymbolicLink()) throw new Error(`symlinked path component is not allowed: ${current}`);
  if (!isLeaf && !stat.isDirectory()) {
    throw new Error(`non-directory path component is not allowed: ${current}`);
  }
  return true;
}

function assertNoSymlinkPath(path: string, requireExisting = false): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    if (!assertPathComponent(current, path, requireExisting, index === parts.length - 1)) return;
  }
  if (requireExisting && realpathSync(absolute) !== absolute) {
    throw new Error(`path is not canonical: ${path}`);
  }
}

function readSetupConfig(opts: CodexHookSetupContext): string | null {
  const path = setupConfigPath(opts);
  assertNoSymlinkPath(path);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error("Codex hooks config is not a regular file");
  return readFileSync(path, "utf8");
}

function setupPlan(
  opts: CodexHookSetupContext,
  cliEntrypoint: string,
  required: boolean,
): CodexHookPlan {
  try {
    const sourcePath = join(opts.packageDir, "hooks", "hooks.json");
    assertNoSymlinkPath(sourcePath, true);
    if (!lstatSync(sourcePath).isFile()) {
      throw new Error(`Codex hook capability manifest is not a regular file: ${sourcePath}`);
    }
    return readCodexHookPlan({
      manifest: opts.hookCapabilities,
      command: codexHookCommand({
        runtimePath: realpathSync(process.execPath),
        cliEntrypoint: realpathSync(cliEntrypoint),
        storageRoot: opts.storageRoot,
      }),
      observedBuild: opts.observedCodexBuild,
    });
  } catch (error) {
    if (required) throw error;
    return {
      state: "unavailable",
      detail: "no probe-qualified CLI hook events are available",
      hooks: {},
    };
  }
}

export function prepareCodexHooksForSetup(
  opts: CodexHookSetupContext,
  cliEntrypoint: string,
  previous?: CodexHookOwnership,
): PreparedCodexHooks {
  const plan = setupPlan(opts, cliEntrypoint, true);
  const command = codexHookCommand({
    runtimePath: realpathSync(process.execPath),
    cliEntrypoint: realpathSync(cliEntrypoint),
    storageRoot: opts.storageRoot,
  });
  return prepareCodexHooks({
    configPath: setupConfigPath(opts),
    current: readSetupConfig(opts),
    previous,
    plan,
    command,
  });
}

export function inspectCodexHooksForSetup(
  opts: CodexHookSetupContext,
  cliEntrypoint: string,
  previous?: CodexHookOwnership,
): { state: CodexHookSetupState; detail: string } {
  try {
    return inspectCodexHooks({
      current: readSetupConfig(opts),
      previous,
      plan: setupPlan(opts, cliEntrypoint, false),
    });
  } catch (error) {
    return { state: "conflict", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function removeCodexHooksForSetup(
  opts: CodexHookSetupContext,
  previous?: CodexHookOwnership,
): ReturnType<typeof removeCodexHooks> {
  try {
    return removeCodexHooks({ current: readSetupConfig(opts), previous });
  } catch (error) {
    return {
      state: "conflict",
      detail: error instanceof Error ? error.message : String(error),
      next: null,
      changed: false,
    };
  }
}

export function writeCodexHooksForSetup(opts: CodexHookSetupContext, content: string | null): void {
  const path = setupConfigPath(opts);
  assertNoSymlinkPath(path);
  if (content === null) {
    unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${parse(path).base}.penumbra-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename already consumed the adjacent temporary file.
    }
  }
}

export function restoreCodexHooksForSetup(
  opts: CodexHookSetupContext,
  prepared: PreparedCodexHooks,
): void {
  if (readSetupConfig(opts) !== prepared.next) {
    throw new Error("Codex hooks changed during rollback; current bytes were preserved");
  }
  writeCodexHooksForSetup(opts, prepared.current);
}
