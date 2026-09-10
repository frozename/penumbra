import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type CapabilityFixture,
  parseCapabilityFixture,
} from "../test/harness-parity/capability-contract.js";
const PROBE_TIMEOUT_MS = 2_000;
const SHUTDOWN_GRACE_MS = 150;
const MAX_CAPTURE_BYTES = 32 * 1024;
const MAX_CAPTURE_FILES = 24;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
type Surface = "cli" | "desktop";
type State = "supported" | "unavailable" | "unknown";
type RawHookEvent = Record<string, unknown>;
const HOOK_SCENARIOS = [
  ["SessionStart", "startup"],
  ["SessionStart", "resume"],
  ["SessionStart", "compact"],
  ["UserPromptSubmit", "prompt", "user_prompt_input_contract_not_validated"],
  ["PreToolUse", "bash"],
  ["PreToolUse", "apply_patch"],
  ["PreToolUse", "mcp"],
  ["PostToolUse", "deferred_bash_completion", "deferred_completion_correlation_not_validated"],
  ["PreCompact", "compact"],
  ["Stop", "stop"],
  ["SessionEnd", "session_end"],
  ["SubagentStart", "child_start"],
  ["SubagentStop", "child_stop"],
] as const;

export interface ProbeInvocation {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}
export interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface CapabilityObservation {
  fixture: CapabilityFixture;
  reason: string | null;
  scenario?: string;
}
export interface CodexCapabilityProbeResult {
  surface: Surface;
  build: string | null;
  cases: CapabilityObservation[];
  cleanupComplete: boolean;
}
interface ProbeCommandResult {
  result: ProbeResult | null;
  reason: string | null;
}
interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}
interface ProbePaths {
  home: string;
  codex: string;
  project: string;
  agents: string;
  capture: string;
  config: string;
  tmp: string;
}
class OwnershipError extends Error {}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}
function readDirectoryIdentity(path: string): DirectoryIdentity {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new OwnershipError("probe_root_symlink");
  if (!entry.isDirectory()) throw new OwnershipError("probe_root_not_directory");
  return { path, dev: entry.dev, ino: entry.ino };
}
function assertSameDirectory(identity: DirectoryIdentity): void {
  const current = readDirectoryIdentity(identity.path);
  if (current.dev !== identity.dev || current.ino !== identity.ino)
    throw new OwnershipError("probe_root_replaced");
}
function ancestorPaths(root: string): string[] {
  const paths: string[] = [];
  let current = root;
  let parent = dirname(current);
  while (parent !== current) {
    paths.push(current);
    current = parent;
    parent = dirname(current);
  }
  paths.push(current);
  return paths;
}
function assertNoSymlinkComponents(root: string): void {
  let current: string = sep;
  for (const part of root.split(sep).filter(Boolean)) {
    current = current === sep ? join(current, part) : join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("probe_root_symlink");
  }
}
class ManagedRoot {
  readonly root: string;
  private readonly ancestors: DirectoryIdentity[];
  private readonly created: DirectoryIdentity[] = [];
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("probe_root_not_absolute");
    assertNoSymlinkComponents(root);
    if (realpathSync(root) !== root) throw new Error("probe_root_not_canonical");
    this.root = root;
    this.ancestors = ancestorPaths(root).map(readDirectoryIdentity);
    if (readdirSync(root).length > 0) throw new Error("probe_root_not_empty");
  }
  assertIntact(): void {
    for (const ancestor of this.ancestors) assertSameDirectory(ancestor);
    for (const created of this.created) assertSameDirectory(created);
  }
  create(name: string): string {
    this.assertIntact();
    const path = join(this.root, name);
    mkdirSync(path, { recursive: false });
    this.created.push(readDirectoryIdentity(path));
    return path;
  }
  cleanup(): boolean {
    try {
      this.assertIntact();
    } catch {
      return false;
    }
    for (const created of [...this.created].reverse()) rmSync(created.path, { recursive: true });
    return true;
  }
}
function isolatedEnv(paths: ProbePaths): Record<string, string> {
  return {
    HOME: paths.home,
    CODEX_HOME: paths.codex,
    XDG_CONFIG_HOME: paths.config,
    TMPDIR: paths.tmp,
    PATH: process.env.PATH ?? "",
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    ...(process.platform === "win32" && process.env.ComSpec
      ? { ComSpec: process.env.ComSpec }
      : {}),
    ...(process.platform === "win32" && process.env.PATHEXT
      ? { PATHEXT: process.env.PATHEXT }
      : {}),
    ...(process.platform === "win32" && process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  };
}
async function runBounded(
  run: (invocation: ProbeInvocation) => Promise<ProbeResult>,
  invocation: ProbeInvocation,
): Promise<ProbeCommandResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(invocation).then((result) => ({ result, reason: null })),
      new Promise<ProbeCommandResult>((resolveTimeout) => {
        timer = setTimeout(() => {
          resolveTimeout({ result: null, reason: "probe_timeout" });
        }, invocation.timeoutMs);
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      result: null,
      reason:
        message === "probe_timeout" || message === "probe_output_limit" ? message : "probe_error",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function resultReason(command: ProbeCommandResult): string | null {
  if (command.reason) return command.reason;
  if (!command.result || command.result.exitCode === 0) return null;
  const text = (command.result.stdout + "\n" + command.result.stderr).toLowerCase();
  if (text.includes("trust") && text.includes("review")) return "trust_review_required";
  if (
    text.includes("authentication_required") ||
    text.includes("authentication required") ||
    text.includes("not logged in") ||
    text.includes("please log in")
  )
    return "authentication_required";
  return "command_failed";
}
function buildFrom(result: ProbeCommandResult): string | null {
  if (result.result?.exitCode !== 0) return null;
  return (
    /codex-cli\s+([^\s]+)/i.exec(result.result.stdout + "\n" + result.result.stderr)?.[1] ?? null
  );
}
function observation(
  surface: Surface,
  build: string | null,
  capability: string,
  state: State,
  now: string,
  reason: string | null,
  scenario?: string,
  input?: RawHookEvent,
): CapabilityObservation {
  const live = state === "supported" || state === "unavailable";
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  const projectCwd = typeof input?.cwd === "string" ? input.cwd : "";
  const agentId = typeof input?.agent_id === "string" ? input.agent_id : null;
  const fixture = {
    surface,
    build,
    capability,
    state,
    evidence: {
      kind: live ? "live" : "contract",
      surface,
      source: "isolated-codex-capability-probe",
      observedAt: now,
      probeId: live ? `isolated-${surface}-${capability}-${scenario ?? "command"}` : null,
    },
    ...(input
      ? {
          input,
          identity: {
            role:
              capability === "SubagentStart" || capability === "SubagentStop" ? "child" : "root",
            sessionId,
            projectCwd,
            agentId:
              capability === "SubagentStart" || capability === "SubagentStop" ? agentId : null,
          },
        }
      : {}),
  };
  return { fixture: parseCapabilityFixture(fixture), reason, scenario };
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
function writeCaptureCommand(path: string): void {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bun",
      'import { closeSync, constants, lstatSync, openSync, writeFileSync } from "node:fs";',
      "const maxBytes = " + String(MAX_CAPTURE_BYTES) + ";",
      "const maxFiles = " + String(MAX_CAPTURE_FILES) + ";",
      "const capture = process.argv[2];",
      "const expectedDev = Number(process.argv[3]); const expectedIno = Number(process.argv[4]);",
      "const matchesCapture = () => { try { const entry = lstatSync(capture); return entry.isDirectory() && !entry.isSymbolicLink() && entry.dev === expectedDev && entry.ino === expectedIno; } catch { return false; } };",
      "if (!matchesCapture()) process.exit(2);",
      "let descriptor; for (let slot = 0; slot < maxFiles; slot += 1) { try { const candidate = openSync(capture + '/event-' + slot + '.json', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); if (!matchesCapture()) { closeSync(candidate); process.exit(2); } descriptor = candidate; break; } catch {} }",
      "if (descriptor === undefined) process.exit(2);",
      "try { const reader = Bun.stdin.stream().getReader(); const chunks = []; let size = 0; while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error('capture_too_large'); } chunks.push(next.value); } const parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_capture'); writeFileSync(descriptor, JSON.stringify(parsed)); } catch { process.exitCode = 2; } finally { closeSync(descriptor); }",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
}
function writeHooksConfig(codex: string, command: string): void {
  const handler = { type: "command", command, timeout: 1 };
  const hooks = {
    SessionStart: [{ matcher: "startup|resume|compact", hooks: [handler] }],
    UserPromptSubmit: [{ hooks: [handler] }],
    PreToolUse: [{ matcher: "Bash|apply_patch|mcp__.*", hooks: [handler] }],
    PostToolUse: [{ matcher: "Bash|apply_patch|mcp__.*", hooks: [handler] }],
    PreCompact: [{ matcher: "manual|auto", hooks: [handler] }],
    Stop: [{ hooks: [handler] }],
    SessionEnd: [{ matcher: "other", hooks: [handler] }],
    SubagentStart: [{ hooks: [handler] }],
    SubagentStop: [{ hooks: [handler] }],
  };
  writeFileSync(join(codex, "hooks.json"), JSON.stringify({ hooks }) + "\n", { mode: 0o600 });
}
function isScenarioMatch(raw: RawHookEvent, capability: string, scenario: string): boolean {
  if (raw.hook_event_name !== capability) return false;
  if (capability === "SessionStart") return raw.source === scenario;
  if (capability === "PreToolUse")
    return scenario === "mcp"
      ? typeof raw.tool_name === "string" && raw.tool_name.startsWith("mcp__")
      : raw.tool_name === (scenario === "bash" ? "Bash" : "apply_patch");
  return scenario !== "deferred_bash_completion";
}
function readCapture(path: string): RawHookEvent | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) return null;
    const buffer = Buffer.allocUnsafe(MAX_CAPTURE_BYTES + 1);
    const size = readSync(descriptor, buffer, 0, buffer.length, null);
    if (size > MAX_CAPTURE_BYTES) return null;
    const parsed: unknown = JSON.parse(buffer.subarray(0, size).toString());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RawHookEvent)
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
function readCaptures(guard: ManagedRoot, paths: ProbePaths): RawHookEvent[] {
  guard.assertIntact();
  const entries = readdirSync(paths.capture).filter(
    (name) => name.startsWith("event-") && name.endsWith(".json"),
  );
  if (entries.length > MAX_CAPTURE_FILES) return [];
  return entries.flatMap((name) => {
    const capture = readCapture(join(paths.capture, name));
    return capture ? [capture] : [];
  });
}
function hookCases(
  surface: Surface,
  build: string | null,
  now: string,
  captures: RawHookEvent[],
  fallbackReason: string | null,
  project: string,
): CapabilityObservation[] {
  return HOOK_SCENARIOS.map(([capability, scenario, contractReason = null]) => {
    const raw = captures.find((capture) => isScenarioMatch(capture, capability, scenario));
    if (
      surface === "cli" &&
      build &&
      raw?.cwd === project &&
      typeof raw.session_id === "string" &&
      contractReason === null
    ) {
      try {
        return observation(surface, build, capability, "supported", now, null, scenario, raw);
      } catch {
        return observation(
          surface,
          build,
          capability,
          "unknown",
          now,
          "invalid_hook_capture",
          scenario,
        );
      }
    }
    return observation(
      surface,
      build,
      capability,
      "unknown",
      now,
      contractReason ??
        (surface === "desktop"
          ? "desktop_interaction_required"
          : (fallbackReason ?? "hook_event_not_observed")),
      scenario,
    );
  });
}
function commandHas(output: ProbeCommandResult, ...terms: string[]): boolean {
  const text = `${output.result?.stdout ?? ""}\n${output.result?.stderr ?? ""}`.toLowerCase();
  return output.result?.exitCode === 0 && terms.every((term) => text.includes(term.toLowerCase()));
}

function createProbePaths(guard: ManagedRoot): ProbePaths {
  return {
    home: guard.create("home"),
    codex: guard.create("codex"),
    project: guard.create("project"),
    agents: guard.create("agents"),
    capture: guard.create("capture"),
    config: guard.create("config"),
    tmp: guard.create("tmp"),
  };
}
interface CommandEvidence {
  build: string | null;
  mcpReason: string | null;
  mcpSupported: boolean;
  pluginSyntax: boolean;
  pluginReason: string | null;
  hookReason: string;
}
async function collectCommandEvidence({
  guard,
  paths,
  surface,
  binary,
  run,
}: {
  guard: ManagedRoot;
  paths: ProbePaths;
  surface: Surface;
  binary: string;
  run: (invocation: ProbeInvocation) => Promise<ProbeResult>;
}): Promise<CommandEvidence> {
  const captureCommand = join(paths.capture, "probe-stdio");
  writeCaptureCommand(captureCommand);
  const captureIdentity = readDirectoryIdentity(paths.capture);
  const runtime = process.execPath;
  if (!runtime) throw new Error("missing_runtime");
  writeHooksConfig(
    paths.codex,
    `${shellQuote(runtime)} ${shellQuote(captureCommand)} ${shellQuote(paths.capture)} ${shellQuote(String(captureIdentity.dev))} ${shellQuote(String(captureIdentity.ino))}`,
  );
  const env = isolatedEnv(paths);
  let timedOut = false;
  const invoke = async (argv: string[]): Promise<ProbeCommandResult> => {
    guard.assertIntact();
    if (timedOut) return { result: null, reason: "probe_timeout" };
    const command = await runBounded(run, {
      argv: [binary, ...argv],
      cwd: paths.project,
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    guard.assertIntact();
    timedOut = command.reason === "probe_timeout";
    return command;
  };
  const version = await invoke(["--version"]);
  const mcpHelp = await invoke(["mcp", "--help"]);
  const mcpSyntax = commandHas(mcpHelp, "add", "list", "get", "remove");
  const unavailable: ProbeCommandResult = { result: null, reason: "mcp_command_unavailable" };
  const mcpAdd = mcpSyntax
    ? await invoke(["mcp", "add", "capability-probe", "--", captureCommand])
    : unavailable;
  const mcpList = mcpSyntax ? await invoke(["mcp", "list"]) : unavailable;
  const mcpGet = mcpSyntax ? await invoke(["mcp", "get", "capability-probe"]) : unavailable;
  const mcpRemove = mcpSyntax ? await invoke(["mcp", "remove", "capability-probe"]) : unavailable;
  const pluginHelp = await invoke(["plugin", "--help"]);
  const hooks = await invoke([
    "exec",
    "--skip-git-repo-check",
    "--cd",
    paths.project,
    "Emit no tool calls. Reply exactly PROBE_OK.",
  ]);
  const mcpReason =
    resultReason(mcpHelp) ??
    resultReason(mcpAdd) ??
    resultReason(mcpList) ??
    resultReason(mcpGet) ??
    resultReason(mcpRemove);
  const build = buildFrom(version);
  return {
    build,
    mcpReason,
    mcpSupported:
      surface === "cli" &&
      build !== null &&
      mcpReason === null &&
      commandHas(mcpList, "capability-probe") &&
      commandHas(mcpGet, "capability-probe", captureCommand) &&
      commandHas(mcpRemove, "capability-probe"),
    pluginSyntax: surface === "cli" && build !== null && resultReason(pluginHelp) === null,
    pluginReason: resultReason(pluginHelp),
    hookReason:
      surface === "desktop"
        ? "desktop_interaction_required"
        : (resultReason(hooks) ?? "trust_review_required"),
  };
}
function resultCases(
  surface: Surface,
  paths: ProbePaths,
  now: () => string,
  evidence: CommandEvidence,
  guard: ManagedRoot,
): CapabilityObservation[] {
  const desktopReason = surface === "desktop" ? "desktop_interaction_required" : null;
  return [
    observation(
      surface,
      evidence.build,
      "mcp_configuration",
      evidence.mcpSupported ? "supported" : "unknown",
      now(),
      evidence.mcpSupported ? null : (desktopReason ?? evidence.mcpReason),
    ),
    observation(
      surface,
      evidence.build,
      "plugin_command_surface",
      evidence.pluginSyntax ? "supported" : "unknown",
      now(),
      evidence.pluginSyntax ? null : (desktopReason ?? evidence.pluginReason),
    ),
    observation(
      surface,
      evidence.build,
      "plugin_management",
      "unknown",
      now(),
      "plugin_installation_not_observed",
    ),
    ...hookCases(
      surface,
      evidence.build,
      now(),
      readCaptures(guard, paths),
      evidence.hookReason,
      paths.project,
    ),
  ];
}
function failedCases(
  surface: Surface,
  paths: ProbePaths,
  now: () => string,
  reason: string,
): CapabilityObservation[] {
  return [
    observation(surface, null, "mcp_configuration", "unknown", now(), reason),
    observation(surface, null, "plugin_command_surface", "unknown", now(), reason),
    observation(surface, null, "plugin_management", "unknown", now(), reason),
    ...hookCases(surface, null, now(), [], reason, paths.project),
  ];
}
export async function runCodexCapabilityProbe({
  root,
  surface,
  binary,
  run,
  now,
}: {
  root: string;
  surface: Surface;
  binary: string;
  run: (invocation: ProbeInvocation) => Promise<ProbeResult>;
  now: () => string;
}): Promise<CodexCapabilityProbeResult> {
  const guard = new ManagedRoot(root);
  const paths = createProbePaths(guard);
  let cleanupComplete = false;
  let result: Omit<CodexCapabilityProbeResult, "cleanupComplete"> = {
    surface,
    build: null,
    cases: failedCases(surface, paths, now, "probe_error"),
  };
  try {
    const evidence = await collectCommandEvidence({ guard, paths, surface, binary, run });
    result = {
      surface,
      build: evidence.build,
      cases: resultCases(surface, paths, now, evidence, guard),
    };
  } catch (error) {
    const reason = error instanceof OwnershipError ? error.message : "probe_error";
    result = { surface, build: null, cases: failedCases(surface, paths, now, reason) };
  } finally {
    cleanupComplete = guard.cleanup();
  }
  return { ...result, cleanupComplete };
}

function drain(
  stream: NodeJS.ReadableStream | null,
  limit: number,
): Promise<{ text: string; overflow: boolean }> {
  if (!stream) return Promise.resolve({ text: "", overflow: false });
  return new Promise((resolveDrain) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limit - size;
      if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
      size += bytes.byteLength;
      if (size > limit) overflow = true;
    });
    stream.once("error", () => {
      resolveDrain({ text: Buffer.concat(chunks).toString(), overflow: true });
    });
    stream.once("end", () => {
      resolveDrain({ text: Buffer.concat(chunks).toString(), overflow });
    });
    stream.resume();
  });
}
function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
function signalOwned(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    return;
  }
}
export async function runProcess(invocation: ProbeInvocation): Promise<ProbeResult> {
  const binary = invocation.argv[0];
  if (!binary) throw new Error("missing_binary");
  const child: ChildProcess = spawn(binary, invocation.argv.slice(1), {
    cwd: invocation.cwd,
    env: invocation.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = drain(child.stdout, MAX_PROCESS_OUTPUT_BYTES);
  const stderr = drain(child.stderr, MAX_PROCESS_OUTPUT_BYTES);
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code: number | null) => {
      resolveExit(code ?? 1);
    });
  });
  const completed = Promise.all([exited, stdout, stderr]);
  const outcome = await Promise.race([
    completed,
    wait(invocation.timeoutMs).then(() => "timeout" as const),
  ]);
  if (
    outcome === "timeout" ||
    (Array.isArray(outcome) && (outcome[1].overflow || outcome[2].overflow))
  ) {
    signalOwned(child, "SIGTERM");
    const stopped = await Promise.race([
      completed.then(() => true),
      wait(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!stopped) signalOwned(child, "SIGKILL");
    const settled = await Promise.race([
      completed.then(() => true),
      wait(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!settled) throw new Error("probe_timeout");
    throw new Error(outcome === "timeout" ? "probe_timeout" : "probe_output_limit");
  }
  return { exitCode: outcome[0], stdout: outcome[1].text, stderr: outcome[2].text };
}
function cliArgument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index === -1 ? undefined : Bun.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("missing_" + name.slice(2));
  return value;
}
function writeOutput(root: ManagedRoot, output: string, result: CodexCapabilityProbeResult): void {
  const resolved = resolve(root.root, output);
  if (!isContained(root.root, resolved)) throw new Error("output_outside_probe_root");
  root.assertIntact();
  const descriptor = openSync(
    resolved,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, JSON.stringify(result, null, 2) + "\n", "utf8");
  } finally {
    closeSync(descriptor);
  }
}
async function main(): Promise<void> {
  const root = cliArgument("--root");
  const output = cliArgument("--output");
  const surface = cliArgument("--surface");
  const binary = cliArgument("--binary");
  if (surface !== "cli" && surface !== "desktop") throw new Error("invalid_surface");
  const result = await runCodexCapabilityProbe({
    root,
    surface,
    binary,
    run: runProcess,
    now: () => new Date().toISOString(),
  });
  if (!result.cleanupComplete) throw new Error("probe_cleanup_incomplete");
  writeOutput(new ManagedRoot(root), output, result);
}
if (import.meta.main) await main();
