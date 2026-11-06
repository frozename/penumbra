import { z } from "zod";

import type { ArtifactHandle, Tool } from "./schema.js";

import {
  ValuePatternRedactor,
  type ValuePatternRule,
  type WorktreeGitHooksStatus,
} from "../preflight-primitives.js";

export const PREFLIGHT_DETAIL_MAX_BYTES = 512;

export const EnvFailureCodeSchema = z.enum([
  "base_missing",
  "code_missing",
  "tests_missing",
  "runtime_mismatch",
  "path_missing_tool",
  "storage_not_isolated",
  "artifact_unreadable",
  "tool_unsupported",
  "hook_missing",
  "hook_unknown",
]);
export type EnvFailureCode = z.infer<typeof EnvFailureCodeSchema>;

export const PreflightAttributionSchema = z.enum(["environment", "policy"]);
export type PreflightAttribution = z.infer<typeof PreflightAttributionSchema>;

export const EnvironmentFailureSchema = z.strictObject({
  attribution: z.literal("environment"),
  code: EnvFailureCodeSchema,
  credit_attempt: z.literal(false),
  probe: z.string().min(1),
  subject: z.string().optional(),
  detail: z.string(),
  remediation: z.literal("provision_via_217").optional(),
});
export type EnvironmentFailure = z.infer<typeof EnvironmentFailureSchema>;

export const PolicyDenialSchema = z.strictObject({
  attribution: z.literal("policy"),
  code: z.literal("permission_denied"),
  credit_attempt: z.literal(false),
  retryable: z.literal(false),
  probe: z.string().min(1),
  subject: z.string().optional(),
  detail: z.string(),
});
export type PolicyDenial = z.infer<typeof PolicyDenialSchema>;

export const PreflightFailureSchema = z.discriminatedUnion("attribution", [
  EnvironmentFailureSchema,
  PolicyDenialSchema,
]);
export type PreflightFailure = z.infer<typeof PreflightFailureSchema>;

export const PreflightResultSchema = z
  .strictObject({
    ready: z.boolean(),
    failures: z.array(PreflightFailureSchema),
  })
  .refine((result) => result.ready === (result.failures.length === 0), {
    message: "ready must be true exactly when there are no failures",
  });
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

export type ProbeOutcome =
  | { status: "ok" }
  | { status: "fail" | "unknown" | "denied"; detail: string };

export type PathProbeOutcome =
  | { status: "ok"; path: string }
  | { status: "fail" | "unknown" | "denied"; detail: string };

export type RuntimeProbeOutcome =
  | { status: "ok"; version: string }
  | { status: "fail" | "unknown" | "denied"; detail: string };

export type HookProbeOutcome =
  | { status: "ok"; hooks: WorktreeGitHooksStatus }
  | { status: "unknown" | "denied"; detail: string };

export interface ProbePort {
  readonly hasBase: () => Promise<ProbeOutcome>;
  readonly hasCode: () => Promise<ProbeOutcome>;
  readonly hasTests: () => Promise<ProbeOutcome>;
  readonly runtime: (name: string) => Promise<RuntimeProbeOutcome>;
  readonly pathTool: (name: string) => Promise<ProbeOutcome>;
  readonly storagePath: () => Promise<PathProbeOutcome>;
  readonly operatorCheckout: () => Promise<PathProbeOutcome>;
  readonly artifactReadable: (handle: ArtifactHandle) => Promise<ProbeOutcome>;
  readonly hookStatus: () => Promise<HookProbeOutcome>;
}

export const PROBE_PORT_KEYS = [
  "hasBase",
  "hasCode",
  "hasTests",
  "runtime",
  "pathTool",
  "storagePath",
  "operatorCheckout",
  "artifactReadable",
  "hookStatus",
] as const satisfies readonly (keyof ProbePort)[];

export interface PreflightRequest {
  readonly runtimes: readonly { name: string; expected: string }[];
  readonly tools: readonly Tool[];
  readonly supported_tool_kinds: readonly string[];
  readonly artifact_handles: readonly ArtifactHandle[];
  readonly home_dir: string;
}

type UnknownProbeOutcome = { status: "unknown"; detail: string };

type NonOkProbeOutcome = {
  status: "fail" | "unknown" | "denied";
  detail: string;
};

const ENV_FAILURE_CODE_BY_PROBE = {
  hasBase: "base_missing",
  hasCode: "code_missing",
  hasTests: "tests_missing",
  runtime: "runtime_mismatch",
  pathTool: "path_missing_tool",
  storagePath: "storage_not_isolated",
  operatorCheckout: "storage_not_isolated",
  artifactReadable: "artifact_unreadable",
} as const satisfies Record<string, EnvFailureCode>;

type EnvProbeName = keyof typeof ENV_FAILURE_CODE_BY_PROBE;

// Mirrors the agentchat maestro-output token rules until a shared core rule set exists.
const TOKEN_REDACTION_RULE: ValuePatternRule = {
  id: "token",
  pattern:
    /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abprs]-[\w-]{10,})/g,
  replacement: "[REDACTED:token]",
};

const HOME_GENERIC_REDACTION_RULE: ValuePatternRule = {
  id: "home_generic",
  pattern: /\/(?:Users|home)\/[^/\s]+/g,
  replacement: "~",
};

const REGEX_SYNTAX_CHARACTERS = /[.*+?^${}()|[\]\\]/g;
const TRAILING_SLASHES = /\/+$/g;

function buildRedactionRules(req: PreflightRequest): ValuePatternRule[] {
  const rules: ValuePatternRule[] = [TOKEN_REDACTION_RULE];
  const homeDir = req.home_dir.replaceAll(TRAILING_SLASHES, "");
  if (homeDir !== "") {
    rules.push({
      id: "home_injected",
      pattern: new RegExp(
        homeDir.replaceAll(REGEX_SYNTAX_CHARACTERS, String.raw`\$&`) + "(?=/|$)",
        "g",
      ),
      replacement: "~",
    });
  }
  rules.push(HOME_GENERIC_REDACTION_RULE);
  return rules;
}

function redactDetail(detail: string, req: PreflightRequest): string {
  const redacted = new ValuePatternRedactor(buildRedactionRules(req)).redactString(detail).redacted;
  const encoded = new TextEncoder().encode(redacted);
  if (encoded.byteLength <= PREFLIGHT_DETAIL_MAX_BYTES) {
    return redacted;
  }
  const truncated = new TextDecoder().decode(encoded.subarray(0, PREFLIGHT_DETAIL_MAX_BYTES));
  return truncated.endsWith("\uFFFD") ? truncated.slice(0, -1) : truncated;
}

function makeEnvFailure(
  code: EnvFailureCode,
  probe: string,
  subject: string | undefined,
  detail: string,
  req: PreflightRequest,
  remediation?: "provision_via_217",
): EnvironmentFailure {
  const entry: EnvironmentFailure = {
    attribution: "environment",
    code,
    credit_attempt: false,
    probe,
    detail: redactDetail(detail, req),
  };
  if (subject !== undefined) entry.subject = subject;
  if (remediation !== undefined) entry.remediation = remediation;
  return entry;
}

function makePolicyDenial(
  probe: string,
  detail: string,
  req: PreflightRequest,
  subject?: string,
): PolicyDenial {
  const entry: PolicyDenial = {
    attribution: "policy",
    code: "permission_denied",
    credit_attempt: false,
    retryable: false,
    probe,
    detail: redactDetail(detail, req),
  };
  if (subject !== undefined) entry.subject = subject;
  return entry;
}

function classifyProbeFailure(
  probe: EnvProbeName,
  outcome: NonOkProbeOutcome,
  req: PreflightRequest,
  subject?: string,
): PreflightFailure {
  if (outcome.status === "denied") {
    return makePolicyDenial(probe, outcome.detail, req, subject);
  }
  return makeEnvFailure(ENV_FAILURE_CODE_BY_PROBE[probe], probe, subject, outcome.detail, req);
}

async function safeProbe<T>(call: () => Promise<T>): Promise<T | UnknownProbeOutcome> {
  try {
    return await call();
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function hasStorageUnder(path: string, parent: string): boolean {
  if (parent === "") {
    return false;
  }
  const pathSegments = path.split("/").filter((segment) => segment !== "");
  const prefixSegments = parent.split("/").filter((segment) => segment !== "");
  if (pathSegments.length < prefixSegments.length) {
    return false;
  }
  return prefixSegments.every((segment, index) => pathSegments[index] === segment);
}

async function collectBaseCodeTests(
  port: ProbePort,
  req: PreflightRequest,
  failures: PreflightFailure[],
): Promise<void> {
  const probes = [
    ["hasBase", port.hasBase],
    ["hasCode", port.hasCode],
    ["hasTests", port.hasTests],
  ] as const;
  for (const [probe, call] of probes) {
    const outcome = await safeProbe(call);
    if (outcome.status !== "ok") {
      failures.push(classifyProbeFailure(probe, outcome, req));
    }
  }
}

async function collectRuntimes(
  port: ProbePort,
  req: PreflightRequest,
  failures: PreflightFailure[],
): Promise<void> {
  for (const { name, expected } of req.runtimes) {
    const outcome = await safeProbe(() => port.runtime(name));
    if (outcome.status !== "ok") {
      failures.push(classifyProbeFailure("runtime", outcome, req, name));
    } else if (outcome.version !== expected) {
      failures.push(
        makeEnvFailure(
          "runtime_mismatch",
          "runtime",
          name,
          `expected ${expected}, got ${outcome.version}`,
          req,
        ),
      );
    }
  }
}

async function collectTools(
  port: ProbePort,
  req: PreflightRequest,
  failures: PreflightFailure[],
): Promise<void> {
  for (const tool of req.tools) {
    const outcome = await safeProbe(() => port.pathTool(tool.command));
    if (outcome.status !== "ok") {
      failures.push(classifyProbeFailure("pathTool", outcome, req, tool.id));
    }
  }
  const supportedKinds = new Set(req.supported_tool_kinds);
  for (const tool of req.tools) {
    if (!supportedKinds.has(tool.kind)) {
      failures.push(makeEnvFailure("tool_unsupported", "pathTool", tool.id, tool.command, req));
    }
  }
}

async function collectStorage(
  port: ProbePort,
  req: PreflightRequest,
  failures: PreflightFailure[],
): Promise<void> {
  const storage = await safeProbe(() => port.storagePath());
  const checkout = await safeProbe(() => port.operatorCheckout());
  if (storage.status === "ok" && checkout.status === "ok") {
    if (
      hasStorageUnder(storage.path, checkout.path) ||
      hasStorageUnder(storage.path, req.home_dir)
    ) {
      failures.push(
        makeEnvFailure("storage_not_isolated", "storagePath", undefined, storage.path, req),
      );
    }
    return;
  }
  if (storage.status !== "ok") {
    failures.push(classifyProbeFailure("storagePath", storage, req));
  }
  if (checkout.status !== "ok") {
    failures.push(classifyProbeFailure("operatorCheckout", checkout, req));
  }
}

async function collectArtifacts(
  port: ProbePort,
  req: PreflightRequest,
  failures: PreflightFailure[],
): Promise<void> {
  for (const handle of req.artifact_handles) {
    const outcome = await safeProbe(() => port.artifactReadable(handle));
    if (outcome.status !== "ok") {
      failures.push(classifyProbeFailure("artifactReadable", outcome, req, handle.id));
    }
  }
}

async function collectHooks(
  port: ProbePort,
  req: PreflightRequest,
  failures: PreflightFailure[],
): Promise<void> {
  const outcome = await safeProbe(port.hookStatus);
  if (outcome.status === "ok") {
    switch (outcome.hooks) {
      case "installed":
      case "not_configured":
        break;
      case "missing":
      case "empty":
        failures.push(
          makeEnvFailure(
            "hook_missing",
            "hookStatus",
            undefined,
            `hooks ${outcome.hooks}`,
            req,
            "provision_via_217",
          ),
        );
    }
    return;
  }
  if (outcome.status === "denied") {
    failures.push(makePolicyDenial("hookStatus", outcome.detail, req));
    return;
  }
  failures.push(makeEnvFailure("hook_unknown", "hookStatus", undefined, outcome.detail, req));
}

export async function runPreflight(
  port: ProbePort,
  req: PreflightRequest,
): Promise<PreflightResult> {
  const failures: PreflightFailure[] = [];
  await collectBaseCodeTests(port, req, failures);
  await collectRuntimes(port, req, failures);
  await collectTools(port, req, failures);
  await collectStorage(port, req, failures);
  await collectArtifacts(port, req, failures);
  await collectHooks(port, req, failures);
  return { ready: failures.length === 0, failures };
}
