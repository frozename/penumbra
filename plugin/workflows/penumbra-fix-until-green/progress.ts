import { createHash } from "node:crypto";

import type { FanoutDefaults, FanoutTask, FanoutTaskResult } from "../_shared/fanout.js";
import type { FixUntilGreenInput } from "./input.js";

import { type CandidateRef, resolveAuthoritativeCandidate } from "./candidate.js";
import { roundMessage } from "./check-parse.js";

/**
 * Pure helpers and evidence-bound repair checkpoints for
 * penumbra-fix-until-green (Issue #393).
 *
 * The progress half extracts failure evidence from worker responses,
 * classifies failures, computes fingerprints for progress detection, and
 * decides whether to repair, escalate once, or stop. The helper half holds
 * the pure dispatch/task plumbing the workflow loop shares. No I/O except
 * node:crypto.
 */

export type RepairStopReason =
  | "contract_defect"
  | "environment_unavailable"
  | "capacity_unavailable"
  | "no_progress";

type FailureClassification = "actionable" | "environment_unavailable" | "capacity_unavailable";

const FENCE_MARKER = /^( {0,3})(`{3,}|~{3,})/;
const FAIL_MARKER = /^ {0,3}CHECK_RESULT:\s*FAIL\b/i;

type OpenFence = { char: string; length: number };

function matchFenceMarker(line: string): { indent: number; char: string; length: number } | null {
  const m = FENCE_MARKER.exec(line);
  const marker = m?.[2];
  if (m === null || marker === undefined) return null;
  return { indent: m[1]?.length ?? 0, char: marker.charAt(0), length: marker.length };
}

function closesFence(line: string, fence: OpenFence): boolean {
  const fm = matchFenceMarker(line);
  if (fm === null) return false;
  return (
    fm.char === fence.char &&
    fm.length >= fence.length &&
    line.slice(fm.indent + fm.length).trim().length === 0
  );
}

function firstFailMarkerIndex(lines: string[]): number {
  let fence: OpenFence | null = null;
  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (FAIL_MARKER.test(line)) return index;
    const fm = matchFenceMarker(line);
    if (fm !== null) fence = { char: fm.char, length: fm.length };
  }
  return -1;
}

function fencedBlocks(lines: string[], start: number): string[] {
  const blocks: string[] = [];
  let fence: OpenFence | null = null;
  let current: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (fence === null) {
      const fm = matchFenceMarker(line);
      if (fm !== null) {
        fence = { char: fm.char, length: fm.length };
        current = [];
      }
      continue;
    }
    if (closesFence(line, fence)) {
      blocks.push(current.join("\n"));
      fence = null;
      continue;
    }
    current.push(line);
  }
  if (fence !== null) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * Extract the failure evidence from a worker or verifier response: the
 * contents of every fenced block that starts after the first unfenced
 * `CHECK_RESULT: FAIL` marker line, or anywhere in the text when there is
 * no marker. An unclosed fence runs to the end of the text. When the text
 * contains no fenced block at all, the whole output is the evidence.
 */
export function failureEvidence(output: string | null): string {
  if (output === null || output.length === 0) return "";
  const lines = output.split("\n");
  const marker = firstFailMarkerIndex(lines);
  const blocks = fencedBlocks(lines, marker === -1 ? 0 : marker + 1);
  return blocks.length === 0 ? output : blocks.join("\n");
}

const ACTIONABLE_PATTERNS = [
  /\berror TS\d+/i,
  /\(fail\) /i,
  /\bexpect\(/i,
  /^\s*Expected:/im,
  /\S+\.(?:[cm]?[jt]sx?|json|py|rs|go)(?::\d+:\d+|\(\d+,\d+\))/i,
];

const ENVIRONMENT_PATTERNS = [
  /command not found/i,
  /\bspawn \S+ ENOENT\b/i,
  /\bENOSPC\b|No space left on device/i,
  /heavy-job lock \S+ not acquired within/i,
  /host memory admission \w+:/i,
  /claim not admitted/i,
];

const CAPACITY_PATTERNS = [
  /\bHTTP\/?\s?429\b/i,
  /\bstatus(?: code)?[:= ]\s*429\b/i,
  /\b429 Too Many Requests\b/i,
  /\brate limit exceeded\b/i,
  /\bquota exceeded\b|\binsufficient_quota\b/i,
  /\b401 Unauthorized\b/i,
  /\boverloaded_error\b/i,
];

/**
 * Classify failure evidence. Fixable evidence always wins: any actionable
 * marker (compiler errors, test assertions, source locations) overrides
 * environment and capacity matches. Provider-shaped capacity patterns are
 * anchored so a bare `429` in test output never trips them.
 */
export function classifyFailure(evidence: string): FailureClassification {
  if (ACTIONABLE_PATTERNS.some((pattern) => pattern.test(evidence))) return "actionable";
  if (ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(evidence))) {
    return "environment_unavailable";
  }
  if (CAPACITY_PATTERNS.some((pattern) => pattern.test(evidence))) {
    return "capacity_unavailable";
  }
  return "actionable";
}

// eslint-disable-next-line no-control-regex -- ESC/C1 CSI are the ANSI introducers being stripped.
const ANSI_ESCAPE = /[\u001b\u009b]\[[0-9;?]*[ -/]*[@-~]/g;
const ISO_TIMESTAMP =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const DURATION = /(?<![\w.])\[?\d+(?:\.\d+)?\s?(?:ms|s)\]?(?!\w)/g;
const HEX_SHA = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

/**
 * Fingerprint failure evidence for progress detection. Normalisation
 * strips ANSI escapes, ISO-8601 timestamps, durations and hex SHAs, then
 * collapses whitespace; bare integers and line:col positions are kept so
 * genuinely different failures stay distinct. Returns the sha256 hex of
 * the normalised text, or null for empty evidence.
 */
export function failureFingerprint(evidence: string): string | null {
  if (evidence.trim().length === 0) return null;
  const normalized = evidence
    .replaceAll(ANSI_ESCAPE, " ")
    .replaceAll(ISO_TIMESTAMP, " ")
    .replaceAll(DURATION, " ")
    .replaceAll(HEX_SHA, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Decide whether a failed round should be repaired or should stop the
 * workflow. Non-actionable classifications stop immediately; actionable
 * evidence that fingerprints identically to the previous failure means
 * no progress was made.
 */
export function decideAfterFailure(input: {
  output: string | null;
  previousFingerprint: string | null;
}):
  | { action: "repair"; fingerprint: string | null }
  | { action: "stop"; reason: RepairStopReason; fingerprint: string | null } {
  const evidence = failureEvidence(input.output);
  const classification = classifyFailure(evidence);
  const fingerprint = failureFingerprint(evidence);
  if (classification !== "actionable") {
    return { action: "stop", reason: classification, fingerprint };
  }
  if (fingerprint !== null && fingerprint === input.previousFingerprint) {
    return { action: "stop", reason: "no_progress", fingerprint };
  }
  return { action: "repair", fingerprint };
}

export type ProgressState = {
  lastFailureFingerprint: string | null;
  escalated: boolean;
};

type AgentInput = Pick<FixUntilGreenInput, "agent" | "escalate_to" | "max_rounds">;

/**
 * Pick the agent for a round: `escalate_to` on the last round, and on any
 * round after a one-shot `no_progress` escalation, otherwise `agent`.
 */
export function agentForRound(
  input: AgentInput,
  roundIndex: number,
  state: { escalated: boolean },
): string {
  const lastRound = roundIndex === input.max_rounds - 1;
  if (input.escalate_to !== undefined && (lastRound || state.escalated)) {
    return input.escalate_to;
  }
  return input.agent;
}

/**
 * Apply `decideAfterFailure` to workflow state. Repair records the new
 * fingerprint; a one-shot `no_progress` with `escalate_to` available flips
 * `state.escalated` and continues as `no_progress_escalate`; every other
 * stop reason stops the loop.
 */
export function applyFailureDecision(
  state: ProgressState,
  input: AgentInput,
  roundIndex: number,
  output: string | null,
  defaultReason: string,
): { reason: string; stop: boolean } {
  const decision = decideAfterFailure({
    output,
    previousFingerprint: state.lastFailureFingerprint,
  });
  if (decision.action === "repair") {
    state.lastFailureFingerprint = decision.fingerprint;
    return { reason: defaultReason, stop: false };
  }
  if (
    decision.reason === "no_progress" &&
    input.escalate_to !== undefined &&
    !state.escalated &&
    roundIndex < input.max_rounds - 1
  ) {
    state.escalated = true;
    return { reason: "no_progress_escalate", stop: false };
  }
  return { reason: decision.reason, stop: true };
}

// ---------------------------------------------------------------------------
// Pure dispatch/task helpers shared by the workflow loop
// ---------------------------------------------------------------------------

export function resolveTaskTitle(task: FixUntilGreenInput["task"]): string {
  return task.task_name ?? "Untitled task";
}

function resolveTaskName(task: FixUntilGreenInput["task"], roundIndex: number): string {
  return task.task_name ?? `fix-${String(roundIndex + 1)}`;
}

export function buildFanoutTask(
  input: FixUntilGreenInput,
  roundIndex: number,
  agent: string,
  prevBranch: string | null,
  prevOutput: string | null,
): FanoutTask {
  const task = input.task;
  const t: FanoutTask = {
    label: `fix#${String(roundIndex + 1)}:${agent}`,
    task_name: resolveTaskName(task, roundIndex),
    initial_agent: agent,
    task_class: task.task_class ?? "STANDARD",
    task_type: task.task_type ?? "implement_small",
    message: roundMessage(
      roundIndex,
      task.message,
      input.check,
      prevBranch,
      prevOutput,
      input.parity_check,
    ),
    max_hops: 1,
  };
  if (task.branch_type) t.branch_type = task.branch_type;
  if (roundIndex === 0) {
    if (input.base && input.base !== "main") t.branch_base = input.base;
  } else {
    t.branch_base = prevBranch ?? undefined;
  }
  return t;
}

export function buildFanoutDefaults(input: FixUntilGreenInput, projectId: string): FanoutDefaults {
  const defaults: FanoutDefaults = {
    project_id: projectId,
    timeout_ms: input.timeout_ms,
  };
  if (input.isolated_install !== undefined) defaults.isolated_install = input.isolated_install;
  return defaults;
}

export type DispatchOutcome =
  | { ok: true; result: FanoutTaskResult; candidate: CandidateRef }
  | { ok: false; reason: string };

export function classifyDispatch(result: FanoutTaskResult | null): DispatchOutcome {
  if (!result) return { ok: false, reason: "agent_dropped" };
  if (result.status !== "completed") return { ok: false, reason: "chain_failed" };
  const candidate = resolveAuthoritativeCandidate(result);
  if (!candidate.ok) return { ok: false, reason: candidate.reason };
  if (typeof result.root_handoff_id !== "string" || result.root_handoff_id.length === 0) {
    return { ok: false, reason: "candidate_response_handoff_missing" };
  }
  if (result.root_handoff_id !== candidate.candidate.handoffId) {
    return { ok: false, reason: "candidate_response_handoff_mismatch" };
  }
  if (typeof result.response_text !== "string" || result.response_text.trim().length === 0) {
    return { ok: false, reason: result.error_summary ?? "missing_response" };
  }
  return { ok: true, result, candidate: candidate.candidate };
}

export function firstNonemptyLine(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, maxLen);
  }
  return null;
}

export function failureTail(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  return text.length > maxLen ? text.slice(-maxLen) : text;
}
