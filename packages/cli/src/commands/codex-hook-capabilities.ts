import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { normalizeCodexHook } from "./codex-hook-contract.js";

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 2_000;
const MAX_FIELD_LENGTH = 8_192;
const PROBE_SOURCE = "isolated-codex-capability-probe";

type Surface = "cli" | "desktop";
type CapabilityState = "supported" | "unavailable" | "unknown";

type CapabilityEvidence = {
  kind: "live" | "contract";
  surface: Surface;
  source: string;
  observedAt: string;
  probeId: string | null;
};

type CapabilityIdentity = {
  role: "root" | "child" | "dispatch" | "unknown";
  sessionId: string;
  projectCwd: string;
  agentId: string | null;
};

type CapabilityFixture = {
  surface: Surface;
  build: string | null;
  capability: string;
  state: CapabilityState;
  evidence: CapabilityEvidence;
  input?: Record<string, unknown>;
  identity?: CapabilityIdentity;
};

type CapabilityCase = {
  fixture: CapabilityFixture;
  reason: string | null;
  scenario?: string;
};

export interface CodexHookCapabilityReport {
  surface: Surface;
  build: string | null;
  cases: CapabilityCase[];
  cleanupComplete: boolean;
}

export interface CodexBuildObservation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CodexBuildObserver = (argv: readonly string[]) => Promise<CodexBuildObservation>;

export type QualifiedCodexHook = {
  event: string;
  matcher?: string;
};

export type CodexHookQualification = {
  hooks: QualifiedCodexHook[];
  detail: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function isSurface(value: unknown): value is Surface {
  return value === "cli" || value === "desktop";
}

function isState(value: unknown): value is CapabilityState {
  return value === "supported" || value === "unavailable" || value === "unknown";
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isBoundedString(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function malformed(detail: string): never {
  throw new Error(`Codex hook capability report is malformed: ${detail}`);
}

function parseEvidence(value: unknown): CapabilityEvidence {
  if (!isRecord(value)) malformed("case evidence must be an object");
  if (value.kind !== "live" && value.kind !== "contract") malformed("evidence kind is invalid");
  if (!isSurface(value.surface)) malformed("evidence surface is invalid");
  if (!isBoundedString(value.source)) malformed("evidence source is invalid");
  if (!isIsoTimestamp(value.observedAt)) {
    malformed("evidence observedAt is invalid");
  }
  if (value.probeId !== null && !isBoundedString(value.probeId)) {
    malformed("evidence probeId is invalid");
  }
  return value as CapabilityEvidence;
}

function parseIdentity(value: unknown): CapabilityIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) malformed("case identity must be an object");
  if (!["root", "child", "dispatch", "unknown"].includes(String(value.role))) {
    malformed("case identity role is invalid");
  }
  if (!isBoundedString(value.sessionId) || !isBoundedString(value.projectCwd)) {
    malformed("case identity is invalid");
  }
  if (value.agentId !== null && !isBoundedString(value.agentId)) {
    malformed("case child identity is invalid");
  }
  return value as CapabilityIdentity;
}

function parseFixture(fixture: Record<string, unknown>): CapabilityFixture {
  if (!isSurface(fixture.surface)) malformed("case surface is invalid");
  if (fixture.build !== null && !isBoundedString(fixture.build)) malformed("case build is invalid");
  if (!isBoundedString(fixture.capability)) malformed("case capability is invalid");
  if (!isState(fixture.state)) malformed("case state is invalid");
  if (fixture.input !== undefined && !isRecord(fixture.input)) malformed("case input is invalid");
  return {
    surface: fixture.surface,
    build: fixture.build,
    capability: fixture.capability,
    state: fixture.state,
    evidence: parseEvidence(fixture.evidence),
    ...(fixture.input ? { input: fixture.input } : {}),
    ...(fixture.identity === undefined ? {} : { identity: parseIdentity(fixture.identity) }),
  };
}

function parseCase(value: unknown): CapabilityCase {
  if (!isRecord(value) || !isRecord(value.fixture)) malformed("case must contain a fixture");
  if (value.reason !== null && !isBoundedString(value.reason)) malformed("case reason is invalid");
  if (value.scenario !== undefined && !isBoundedString(value.scenario)) {
    malformed("case scenario is invalid");
  }
  return {
    fixture: parseFixture(value.fixture),
    reason: value.reason,
    ...(value.scenario === undefined ? {} : { scenario: value.scenario }),
  };
}

export function parseCodexHookCapabilityReport(raw: unknown): CodexHookCapabilityReport {
  if (!isRecord(raw)) malformed("top level must be an object");
  if (!isSurface(raw.surface)) malformed("surface is invalid");
  if (raw.build !== null && !isBoundedString(raw.build)) malformed("build is invalid");
  if (!Array.isArray(raw.cases)) malformed("cases must be an array");
  if (typeof raw.cleanupComplete !== "boolean") malformed("cleanupComplete is invalid");
  return {
    surface: raw.surface,
    build: raw.build,
    cases: raw.cases.map(parseCase),
    cleanupComplete: raw.cleanupComplete,
  };
}

function readBoundedReport(path: string): unknown {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`capability report must be an absolute normalized path: ${path}`);
  }
  if (realpathSync(path) !== path)
    throw new Error(`capability report path is not canonical: ${path}`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`capability report is not a regular file: ${path}`);
    if (stat.size > MAX_REPORT_BYTES) throw new Error("Codex hook capability report is too large");
    const buffer = Buffer.allocUnsafe(MAX_REPORT_BYTES + 1);
    let size = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
      if (size > MAX_REPORT_BYTES) throw new Error("Codex hook capability report is too large");
    }
    return JSON.parse(buffer.subarray(0, size).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) malformed("JSON is invalid");
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

async function drainBounded(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    cancellation ??= reader.cancel().catch(() => {
      // Cancellation may race with the stream closing naturally.
    });
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROCESS_OUTPUT_BYTES) {
        throw new Error("Codex version output exceeded the bounded limit");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await cancellation;
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const observeCodexBuild: CodexBuildObserver = async (argv) => {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const state = { timedOut: false };
  const outputAbort = new AbortController();
  const abort = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Signal delivery may race with the child exiting naturally.
    }
    outputAbort.abort();
  };
  const exited = child.exited;
  const stdout = drainBounded(child.stdout, outputAbort.signal);
  const stderr = drainBounded(child.stderr, outputAbort.signal);
  const timer = setTimeout(() => {
    state.timedOut = true;
    abort();
  }, VERSION_TIMEOUT_MS);
  try {
    const [exitCode, stdoutText, stderrText] = await Promise.all([exited, stdout, stderr]);
    if (state.timedOut) throw new Error("Codex version observation timed out");
    return { exitCode, stdout: stdoutText, stderr: stderrText };
  } catch (error) {
    abort();
    await Promise.allSettled([exited, stdout, stderr]);
    if (state.timedOut) throw new Error("Codex version observation timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

function buildFromObservation(observation: CodexBuildObservation): string {
  if (observation.exitCode !== 0) throw new Error("Codex --version observation failed");
  const output = `${observation.stdout}\n${observation.stderr}`;
  const build = /codex-cli\s+([^\s]+)/i.exec(output)?.[1];
  if (!isBoundedString(build)) throw new Error("Codex --version did not report a valid build");
  return build;
}

export async function loadCodexHookCapabilities(opts: {
  reportPath: string;
  observeBuild?: CodexBuildObserver;
  versionArgv?: readonly string[];
}): Promise<{ report: CodexHookCapabilityReport; observedBuild: string }> {
  const report = parseCodexHookCapabilityReport(readBoundedReport(opts.reportPath));
  const observation = await (opts.observeBuild ?? observeCodexBuild)(
    opts.versionArgv ?? ["codex", "--version"],
  );
  return { report, observedBuild: buildFromObservation(observation) };
}

function exactMatcher(value: string): string {
  return `^${value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function toolScenarioMatcher(input: Record<string, unknown>, scenario: string): string | undefined {
  if (scenario === "deferred_bash_completion") return undefined;
  const tool = typeof input.tool_name === "string" ? input.tool_name : null;
  const matches =
    (scenario === "bash" && tool === "Bash") ||
    (scenario === "apply_patch" && tool === "apply_patch") ||
    (scenario === "mcp" && (tool?.startsWith("mcp__") ?? false)) ||
    ((scenario === "exec_command" || scenario === "write_stdin") && tool === scenario);
  return matches && tool ? exactMatcher(tool) : undefined;
}

function matchedValue(
  actual: unknown,
  expected: string,
  allowed: readonly string[],
): string | undefined {
  return typeof actual === "string" && actual === expected && allowed.includes(actual)
    ? exactMatcher(actual)
    : undefined;
}

function scenarioMatcher(row: CapabilityCase): string | null | undefined {
  const input = row.fixture.input;
  const scenario = row.scenario;
  if (!input || !scenario) return undefined;
  const matcherlessScenario: Record<string, string> = {
    Stop: "stop",
    SubagentStart: "child_start",
    SubagentStop: "child_stop",
  };
  const matcherless = matcherlessScenario[row.fixture.capability];
  if (matcherless) return scenario === matcherless ? null : undefined;
  switch (row.fixture.capability) {
    case "SessionStart":
      return matchedValue(input.source, scenario, ["startup", "resume", "compact"]);
    case "PreToolUse":
    case "PostToolUse":
      return toolScenarioMatcher(input, scenario);
    case "PreCompact":
      return scenario === "compact"
        ? matchedValue(input.trigger, String(input.trigger), ["manual", "auto"])
        : undefined;
    case "SessionEnd":
      return scenario === "session_end" && input.reason === "other"
        ? exactMatcher("other")
        : undefined;
    default:
      return undefined;
  }
}

function hasMatchingLiveEvidence(
  fixture: CapabilityFixture,
  row: CapabilityCase,
  build: string,
): boolean {
  return (
    fixture.surface === "cli" &&
    fixture.build === build &&
    fixture.state === "supported" &&
    fixture.evidence.kind === "live" &&
    fixture.evidence.surface === "cli" &&
    fixture.evidence.source === PROBE_SOURCE &&
    fixture.evidence.probeId ===
      `isolated-${fixture.surface}-${fixture.capability}-${row.scenario ?? "command"}` &&
    row.reason === null
  );
}

function hasMatchingLineage(fixture: CapabilityFixture, identity: CapabilityIdentity): boolean {
  const child = fixture.capability === "SubagentStart" || fixture.capability === "SubagentStop";
  return child ? identity.role === "child" : identity.role === "root";
}

function qualifiedHook(row: CapabilityCase, build: string): QualifiedCodexHook | string {
  const fixture = row.fixture;
  if (!hasMatchingLiveEvidence(fixture, row, build)) {
    return "case lacks matching live CLI evidence";
  }
  const input = fixture.input;
  const identity = fixture.identity;
  if (!input || !identity) return "case lacks validated event input and identity";
  if (!isAbsolute(identity.projectCwd)) return "case project identity is not absolute";
  if (!hasMatchingLineage(fixture, identity)) {
    return "case lineage identity does not match its event";
  }
  const child = identity.role === "child";
  const normalized = normalizeCodexHook(input, {
    role: "maestro",
    rootSessionId: identity.sessionId,
    provenance: "verified-session-correlation",
  });
  if (normalized?.event !== fixture.capability || normalized.cwd !== identity.projectCwd) {
    return "case input does not match its event and project identity";
  }
  const sessionMatches = child
    ? normalized.parentSessionId === identity.sessionId && normalized.agentId === identity.agentId
    : normalized.sessionId === identity.sessionId && normalized.lineage === "root";
  if (!sessionMatches) return "case session or child identity does not match its input";
  const matcher = scenarioMatcher(row);
  if (matcher === undefined) return "case scenario does not match its observed source or tool";
  return { event: normalized.event, ...(matcher === null ? {} : { matcher }) };
}

function bindReportBuild(
  report: CodexHookCapabilityReport,
  observedBuild: string | undefined,
): { ok: true; build: string } | { ok: false; reason: string } {
  if (report.surface !== "cli") {
    return { ok: false, reason: "desktop capability evidence does not qualify CLI hooks" };
  }
  if (!report.cleanupComplete)
    return { ok: false, reason: "capability probe cleanup is incomplete" };
  if (!isBoundedString(report.build) || !isBoundedString(observedBuild)) {
    return { ok: false, reason: "capability report and observed Codex CLI builds are required" };
  }
  return report.build === observedBuild
    ? { ok: true, build: report.build }
    : {
        ok: false,
        reason: `capability report build ${report.build} does not match observed Codex CLI build ${observedBuild}`,
      };
}

export function qualifyCodexHookReport(
  raw: unknown,
  observedBuild: string | undefined,
): CodexHookQualification {
  let report: CodexHookCapabilityReport;
  try {
    report = parseCodexHookCapabilityReport(raw);
  } catch (error) {
    return { hooks: [], detail: error instanceof Error ? error.message : String(error) };
  }
  const binding = bindReportBuild(report, observedBuild);
  if (!binding.ok) return { hooks: [], detail: binding.reason };
  const hooks: QualifiedCodexHook[] = [];
  const omissions = new Set<string>();
  const seen = new Set<string>();
  for (const row of report.cases) {
    const candidate = qualifiedHook(row, binding.build);
    if (typeof candidate === "string") {
      omissions.add(candidate);
      continue;
    }
    const key = `${candidate.event}:${candidate.matcher ?? ""}`;
    if (!seen.has(key)) {
      hooks.push(candidate);
      seen.add(key);
    }
  }
  const omissionDetail = [...omissions].slice(0, 3).join("; ");
  return {
    hooks,
    detail:
      hooks.length > 0
        ? `${String(hooks.length)} probe-qualified CLI hook scenarios are installed`
        : `no probe-qualified CLI hook scenarios are available${omissionDetail ? `; ${omissionDetail}` : ""}`,
  };
}
