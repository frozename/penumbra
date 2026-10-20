import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

import type {
  CodexPluginOwnership,
  CodexSetupHost,
  CodexSetupHostResult,
} from "./codex-plugin-ownership.js";

import {
  prepareCodexPluginProfilePath,
  removePreparedCodexPluginProfilePath,
  validateCodexPluginProfilePath,
} from "./codex-plugin-profile.js";

const SUPPORTED_BUILD = "0.153.4";
const MARKETPLACE_NAME = "penumbra-local";
const PLUGIN_NAME = "penumbra";
const PLUGIN_VERSION = "0.1.0";
const PLUGIN_IDENTIFIER = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface HostOptions {
  codexDir: string;
  marketplaceRoot: string;
  pluginRoot: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface HostContext extends HostOptions {
  executable: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  installArgv: string[];
  statusArgv: string[];
  uninstallArgv: string[];
  marketplaceAddArgv: string[];
  marketplaceListArgv: string[];
  marketplaceRemoveArgv: string[];
  ownership: CodexPluginOwnership;
}

type PluginListState =
  | { state: "installed" }
  | { state: "absent" }
  | { state: "unknown"; exactIdentity: boolean };

type MarketplaceListState = "absent" | "present" | "unknown";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function positiveBound(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function assertCanonicalDirectory(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} is not absolute`);
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new Error(`${label} is absent`);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not canonical`);
  }
  if (realpathSync(path) !== path) throw new Error(`${label} is not canonical`);
}

function readJsonFile(path: string, label: string): Record<string, unknown> {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || realpathSync(path) !== path) {
    throw new Error(`${label} is not a canonical regular file`);
  }
  const parsed = parseJsonObject(readFileSync(path, "utf8"));
  if (!parsed) throw new Error(`${label} is malformed`);
  return parsed;
}

function validateBundle(opts: HostOptions): void {
  assertCanonicalDirectory(opts.marketplaceRoot, "marketplace root");
  assertCanonicalDirectory(opts.pluginRoot, "plugin root");
  if (opts.pluginRoot !== join(opts.marketplaceRoot, PLUGIN_NAME)) {
    throw new Error("plugin root does not match the bundled marketplace layout");
  }
  const marketplace = readJsonFile(
    join(opts.marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    "marketplace manifest",
  );
  const plugins = marketplace.plugins;
  const entry = Array.isArray(plugins) && plugins.length === 1 ? record(plugins[0]) : undefined;
  const source = record(entry?.source);
  const policy = record(entry?.policy);
  if (
    marketplace.name !== MARKETPLACE_NAME ||
    entry?.name !== PLUGIN_NAME ||
    source?.source !== "local" ||
    source.path !== `./${PLUGIN_NAME}` ||
    policy?.installation !== "AVAILABLE" ||
    policy.authentication !== "ON_INSTALL" ||
    entry.category !== "Productivity"
  ) {
    throw new Error("marketplace manifest does not match the bundled Penumbra identity");
  }
  const manifest = readJsonFile(
    join(opts.pluginRoot, ".codex-plugin", "plugin.json"),
    "plugin manifest",
  );
  if (manifest.name !== PLUGIN_NAME || manifest.version !== PLUGIN_VERSION) {
    throw new Error("plugin manifest does not match the bundled Penumbra identity");
  }
}

function killProcessTree(child: { pid: number; kill(signal: NodeJS.Signals): void }): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The child process group may already be gone.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may already have exited.
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("Codex command output exceeded the bounded limit");
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deadline: number,
  maxOutputBytes: number,
): Promise<CommandResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Codex plugin operation timed out");
  const child = Bun.spawn([...argv], {
    detached: process.platform !== "win32",
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = new AbortController();
  const state = { timedOut: false };
  const exited = child.exited;
  const stdout = readBounded(child.stdout, maxOutputBytes, abort.signal);
  const stderr = readBounded(child.stderr, maxOutputBytes, abort.signal);
  const timer = setTimeout(() => {
    state.timedOut = true;
    killProcessTree(child);
    abort.abort();
  }, remaining);
  try {
    const [exitCode, stdoutText, stderrText] = await Promise.all([exited, stdout, stderr]);
    if (state.timedOut) throw new Error("Codex plugin operation timed out");
    return { exitCode, stdout: stdoutText, stderr: stderrText };
  } catch (error) {
    killProcessTree(child);
    abort.abort();
    await Promise.allSettled([exited, stdout, stderr]);
    if (state.timedOut) throw new Error("Codex plugin operation timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function runProfileCommand(
  context: HostContext,
  argv: readonly string[],
  deadline: number,
): Promise<CommandResult> {
  validateCodexPluginProfilePath(context.codexDir);
  return runCommand(argv, context.env, deadline, context.maxOutputBytes);
}

function exactOwnership(opts: HostOptions, pluginOwned = true): CodexPluginOwnership {
  return {
    identifier: PLUGIN_IDENTIFIER,
    marketplaceName: MARKETPLACE_NAME,
    marketplaceRoot: opts.marketplaceRoot,
    pluginRoot: opts.pluginRoot,
    marketplaceOwned: true,
    pluginOwned,
  };
}

function ownershipMatches(
  value: CodexPluginOwnership | undefined,
  expected: CodexPluginOwnership,
): boolean {
  const candidate = value as Record<string, unknown> | undefined;
  return (
    candidate?.identifier === expected.identifier &&
    candidate.marketplaceName === expected.marketplaceName &&
    candidate.marketplaceRoot === expected.marketplaceRoot &&
    candidate.pluginRoot === expected.pluginRoot &&
    candidate.marketplaceOwned === true &&
    typeof candidate.pluginOwned === "boolean"
  );
}

function exactInstalledIdentity(value: Record<string, unknown>, opts: HostOptions): boolean {
  const source = record(value.source);
  const marketplaceSource = record(value.marketplaceSource);
  return (
    value.pluginId === PLUGIN_IDENTIFIER &&
    value.name === PLUGIN_NAME &&
    value.marketplaceName === MARKETPLACE_NAME &&
    value.version === PLUGIN_VERSION &&
    source?.source === "local" &&
    source.path === opts.pluginRoot &&
    marketplaceSource?.sourceType === "local" &&
    marketplaceSource.source === opts.marketplaceRoot &&
    value.installPolicy === "AVAILABLE" &&
    value.authPolicy === "ON_INSTALL"
  );
}

function parsePluginList(output: CommandResult, opts: HostOptions): PluginListState {
  if (output.exitCode !== 0 || output.stderr.trim() !== "") {
    return { state: "unknown", exactIdentity: false };
  }
  const parsed = parseJsonObject(output.stdout);
  if (!parsed || !Array.isArray(parsed.installed) || !Array.isArray(parsed.available)) {
    return { state: "unknown", exactIdentity: false };
  }
  if (parsed.installed.length === 0) return { state: "absent" };
  if (parsed.installed.length !== 1) return { state: "unknown", exactIdentity: false };
  const installed = record(parsed.installed[0]);
  if (!installed) return { state: "unknown", exactIdentity: false };
  const exactIdentity = exactInstalledIdentity(installed, opts);
  if (!exactIdentity || installed.installed !== true || installed.enabled !== true) {
    return { state: "unknown", exactIdentity };
  }
  return { state: "installed" };
}

function marketplaceIdentity(value: unknown): { name: string; root: string } | undefined {
  const marketplace = record(value);
  const source = record(marketplace?.marketplaceSource);
  const name = marketplace?.name;
  const root = marketplace?.root;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof root !== "string" ||
    !isAbsolute(root) ||
    resolve(root) !== root ||
    source?.sourceType !== "local" ||
    source.source !== root
  ) {
    return undefined;
  }
  try {
    assertCanonicalDirectory(root, "registered marketplace root");
  } catch {
    return undefined;
  }
  return { name, root };
}

function parseMarketplaceList(output: CommandResult, opts: HostOptions): MarketplaceListState {
  if (output.exitCode !== 0 || output.stderr.trim() !== "") return "unknown";
  const parsed = parseJsonObject(output.stdout);
  if (!parsed || !Array.isArray(parsed.marketplaces)) return "unknown";
  const names = new Set<string>();
  let targetPresent = false;
  for (const value of parsed.marketplaces) {
    const marketplace = marketplaceIdentity(value);
    if (!marketplace || names.has(marketplace.name)) return "unknown";
    names.add(marketplace.name);
    if (marketplace.name === MARKETPLACE_NAME) {
      targetPresent = true;
      if (marketplace.root !== opts.marketplaceRoot) return "present";
    }
  }
  return targetPresent ? "present" : "absent";
}

function marketplaceAdded(output: CommandResult, opts: HostOptions): boolean {
  const parsed =
    output.exitCode === 0 && output.stderr.trim() === ""
      ? parseJsonObject(output.stdout)
      : undefined;
  return (
    parsed?.marketplaceName === MARKETPLACE_NAME &&
    parsed.installedRoot === opts.marketplaceRoot &&
    parsed.alreadyAdded === false
  );
}

function pluginAdded(output: CommandResult, opts: HostOptions): boolean {
  const parsed =
    output.exitCode === 0 && output.stderr.trim() === ""
      ? parseJsonObject(output.stdout)
      : undefined;
  return (
    parsed?.pluginId === PLUGIN_IDENTIFIER &&
    parsed.name === PLUGIN_NAME &&
    parsed.marketplaceName === MARKETPLACE_NAME &&
    parsed.version === PLUGIN_VERSION &&
    parsed.installedPath ===
      join(opts.codexDir, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_VERSION) &&
    parsed.authPolicy === "ON_INSTALL"
  );
}

function pluginRemoved(output: CommandResult): boolean {
  const parsed =
    output.exitCode === 0 && output.stderr.trim() === ""
      ? parseJsonObject(output.stdout)
      : undefined;
  return (
    parsed?.pluginId === PLUGIN_IDENTIFIER &&
    parsed.name === PLUGIN_NAME &&
    parsed.marketplaceName === MARKETPLACE_NAME
  );
}

function marketplaceRemoved(output: CommandResult): boolean {
  const parsed =
    output.exitCode === 0 && output.stderr.trim() === ""
      ? parseJsonObject(output.stdout)
      : undefined;
  return parsed?.marketplaceName === MARKETPLACE_NAME && parsed.installedRoot === null;
}

function unavailable(
  detail: string,
  state: "unavailable" | "unknown" = "unavailable",
): CodexSetupHost {
  return {
    plugin: { state, detail },
    invoke: () => Promise.resolve({ ok: false, detail }),
  };
}

function sameArgv(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function qualificationStderrMatches(stderr: string, codexDir: string): boolean {
  return (
    stderr === "" ||
    stderr ===
      `WARNING: proceeding, even though we could not create PATH aliases: CODEX_HOME points to "${codexDir}", but that path does not exist\n`
  );
}

async function qualify(context: HostContext): Promise<boolean> {
  const deadline = Date.now() + context.timeoutMs;
  const version = await runProfileCommand(context, [context.executable, "--version"], deadline);
  if (
    version.exitCode !== 0 ||
    version.stdout !== `codex-cli ${SUPPORTED_BUILD}\n` ||
    !qualificationStderrMatches(version.stderr, context.codexDir)
  ) {
    return false;
  }
  const pluginHelp = await runProfileCommand(
    context,
    [context.executable, "plugin", "--help"],
    deadline,
  );
  const marketplaceHelp = await runProfileCommand(
    context,
    [context.executable, "plugin", "marketplace", "--help"],
    deadline,
  );
  return (
    pluginHelp.exitCode === 0 &&
    qualificationStderrMatches(pluginHelp.stderr, context.codexDir) &&
    ["add", "list", "remove", "marketplace"].every((word) => pluginHelp.stdout.includes(word)) &&
    marketplaceHelp.exitCode === 0 &&
    qualificationStderrMatches(marketplaceHelp.stderr, context.codexDir) &&
    ["add", "list", "remove"].every((word) => marketplaceHelp.stdout.includes(word))
  );
}

class QualifiedCodexPluginHost implements CodexSetupHost {
  readonly plugin;

  constructor(private readonly context: HostContext) {
    this.plugin = {
      state: "supported" as const,
      identifier: PLUGIN_IDENTIFIER,
      installArgv: context.installArgv,
      statusArgv: context.statusArgv,
      uninstallArgv: context.uninstallArgv,
    };
  }

  async invoke(
    argv: readonly string[],
    ownership?: CodexPluginOwnership,
  ): Promise<CodexSetupHostResult> {
    const deadline = Date.now() + this.context.timeoutMs;
    try {
      if (sameArgv(argv, this.context.statusArgv)) {
        return await this.statusResult(ownership, deadline);
      }
      if (sameArgv(argv, this.context.installArgv)) return await this.install(ownership, deadline);
      if (sameArgv(argv, this.context.uninstallArgv))
        return await this.uninstall(ownership, deadline);
      return { ok: false, detail: "unrecognized Codex plugin adapter argv" };
    } catch {
      return { ok: false, detail: "Codex plugin operation failed or exceeded its bound" };
    }
  }

  private run(argv: readonly string[], deadline: number): Promise<CommandResult> {
    return runProfileCommand(this.context, argv, deadline);
  }

  private async status(deadline: number): Promise<PluginListState> {
    return parsePluginList(await this.run(this.context.statusArgv, deadline), this.context);
  }

  private async statusResult(
    ownership: CodexPluginOwnership | undefined,
    deadline: number,
  ): Promise<CodexSetupHostResult> {
    const current = await this.status(deadline);
    if (current.state === "installed") {
      if (!ownershipMatches(ownership, this.context.ownership) || !ownership?.pluginOwned) {
        return { ok: false, detail: "installed plugin does not have exact persisted ownership" };
      }
      return {
        ok: true,
        installed: true,
        detail: "owned plugin is enabled and matches the bundled local source",
      };
    }
    if (current.state === "absent") {
      return {
        ok: true,
        installed: false,
        detail: "plugin is absent from the complete marketplace list",
      };
    }
    return { ok: false, detail: "plugin list did not prove an installed or absent state" };
  }

  private async removeMarketplace(deadline: number): Promise<boolean> {
    return marketplaceRemoved(await this.run(this.context.marketplaceRemoveArgv, deadline));
  }

  private async removePlugin(deadline: number): Promise<boolean> {
    if (!pluginRemoved(await this.run(this.context.uninstallArgv, deadline))) return false;
    return (await this.status(deadline)).state === "absent";
  }

  private async rollbackFresh(current: PluginListState, deadline: number): Promise<boolean> {
    let pluginAbsent = current.state === "absent";
    if (current.state === "installed") pluginAbsent = await this.removePlugin(deadline);
    if (current.state === "unknown" && current.exactIdentity) {
      pluginAbsent = await this.removePlugin(deadline);
    }
    return pluginAbsent && (await this.removeMarketplace(deadline));
  }

  private async install(
    ownership: CodexPluginOwnership | undefined,
    deadline: number,
  ): Promise<CodexSetupHostResult> {
    if (ownership === undefined) return await this.installFresh(deadline);
    if (!ownershipMatches(ownership, this.context.ownership)) {
      return { ok: false, detail: "plugin ownership does not match the bundled marketplace" };
    }
    const current = await this.status(deadline);
    if (current.state === "installed") {
      return ownership.pluginOwned
        ? { ok: true, installed: true, ownership: this.context.ownership }
        : { ok: false, detail: "an unowned plugin occupies the owned marketplace" };
    }
    if (current.state !== "absent") return { ok: false, detail: "plugin repair status is unknown" };
    return await this.addAndConfirm(true, deadline);
  }

  private async installFresh(deadline: number): Promise<CodexSetupHostResult> {
    const createdProfile = prepareCodexPluginProfilePath(this.context.codexDir);
    try {
      const prepared = await this.prepareFreshInstall(deadline);
      const result =
        prepared === "ready"
          ? await this.addAndConfirm(false, deadline)
          : {
              ok: false,
              detail: "plugin absence was not proven before installation",
              ...(prepared === "owned_ambiguous"
                ? { ownership: exactOwnership(this.context, false) }
                : {}),
            };
      if (createdProfile && !result.ok && !result.ownership) {
        removePreparedCodexPluginProfilePath(this.context.codexDir);
      }
      return result;
    } catch (error) {
      if (createdProfile) removePreparedCodexPluginProfilePath(this.context.codexDir);
      throw error;
    }
  }

  private async tryRollback(current: PluginListState, deadline: number): Promise<boolean> {
    try {
      return await this.rollbackFresh(current, deadline);
    } catch {
      return false;
    }
  }

  private async addAndConfirm(
    priorOwned: boolean,
    deadline: number,
  ): Promise<CodexSetupHostResult> {
    let addResult: CommandResult;
    try {
      addResult = await this.run(this.context.installArgv, deadline);
    } catch {
      return {
        ok: false,
        detail: "plugin add failed or exceeded its bound",
        ...(priorOwned ? {} : { ownership: exactOwnership(this.context, false) }),
      };
    }
    if (!pluginAdded(addResult, this.context)) {
      const current = await this.status(deadline).catch(
        (): PluginListState => ({ state: "unknown", exactIdentity: false }),
      );
      const cleaned = priorOwned || (await this.tryRollback(current, deadline));
      return {
        ok: false,
        detail: "plugin add response did not match the qualified protocol",
        ...(cleaned ? {} : { ownership: exactOwnership(this.context, false) }),
      };
    }
    let confirmed: PluginListState;
    try {
      confirmed = await this.status(deadline);
    } catch {
      return {
        ok: false,
        detail: "plugin add confirmation failed or exceeded its bound",
        ...(priorOwned ? {} : { ownership: exactOwnership(this.context, false) }),
      };
    }
    if (confirmed.state === "installed") {
      return { ok: true, installed: true, ownership: this.context.ownership };
    }
    const cleaned = priorOwned || (await this.tryRollback(confirmed, deadline));
    return {
      ok: false,
      detail: "plugin add was not confirmed by an exact enabled list entry",
      ...(cleaned ? {} : { ownership: exactOwnership(this.context, false) }),
    };
  }

  private async prepareFreshInstall(
    deadline: number,
  ): Promise<"ready" | "unowned_failure" | "owned_ambiguous"> {
    const inventory = parseMarketplaceList(
      await this.run(this.context.marketplaceListArgv, deadline),
      this.context,
    );
    if (inventory !== "absent") return "unowned_failure";
    const added = await this.run(this.context.marketplaceAddArgv, deadline);
    if (!marketplaceAdded(added, this.context)) return "unowned_failure";
    try {
      return (await this.status(deadline)).state === "absent" ? "ready" : "owned_ambiguous";
    } catch {
      return "owned_ambiguous";
    }
  }

  private async uninstall(
    ownership: CodexPluginOwnership | undefined,
    deadline: number,
  ): Promise<CodexSetupHostResult> {
    if (!ownershipMatches(ownership, this.context.ownership)) {
      return { ok: false, detail: "owned marketplace removal was not authorized" };
    }
    const current = await this.status(deadline);
    if (current.state === "unknown") {
      return { ok: false, detail: "plugin removal status is unknown" };
    }
    if (current.state === "installed" && ownership?.pluginOwned !== true) {
      return { ok: false, detail: "unowned plugin was preserved in the owned marketplace" };
    }
    if (current.state === "installed" && !(await this.removePlugin(deadline))) {
      return { ok: false, detail: "plugin removal was not confirmed absent" };
    }
    if (!(await this.removeMarketplace(deadline))) {
      return { ok: false, detail: "owned marketplace removal was not confirmed" };
    }
    return {
      ok: true,
      installed: false,
      detail: "owned plugin and marketplace registration are absent",
    };
  }
}

export async function createCodexPluginHost(opts: HostOptions): Promise<CodexSetupHost> {
  try {
    validateCodexPluginProfilePath(opts.codexDir);
    validateBundle(opts);
  } catch {
    return unavailable("bundled Codex marketplace validation failed");
  }
  const timeoutMs = positiveBound(opts.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxOutputBytes = positiveBound(opts.maxOutputBytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  const executable = opts.executable ?? "codex";
  const env = { ...(opts.env ?? process.env), CODEX_HOME: opts.codexDir };
  const installArgv = [executable, "plugin", "add", PLUGIN_IDENTIFIER, "--json"];
  const statusArgv = [executable, "plugin", "list", "--marketplace", MARKETPLACE_NAME, "--json"];
  const uninstallArgv = [executable, "plugin", "remove", PLUGIN_IDENTIFIER, "--json"];
  const marketplaceAddArgv = [
    executable,
    "plugin",
    "marketplace",
    "add",
    opts.marketplaceRoot,
    "--json",
  ];
  const marketplaceListArgv = [executable, "plugin", "marketplace", "list", "--json"];
  const marketplaceRemoveArgv = [
    executable,
    "plugin",
    "marketplace",
    "remove",
    MARKETPLACE_NAME,
    "--json",
  ];
  const context: HostContext = {
    ...opts,
    executable,
    env,
    timeoutMs,
    maxOutputBytes,
    installArgv,
    statusArgv,
    uninstallArgv,
    marketplaceAddArgv,
    marketplaceListArgv,
    marketplaceRemoveArgv,
    ownership: exactOwnership(opts),
  };
  try {
    if (!(await qualify(context))) {
      return unavailable(
        "Codex 0.153.4 version/help did not match the qualified command family",
        "unknown",
      );
    }
  } catch {
    return unavailable(
      "Codex plugin version/help qualification failed or exceeded its bound",
      "unknown",
    );
  }

  return new QualifiedCodexPluginHost(context);
}
