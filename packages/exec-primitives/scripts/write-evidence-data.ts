/**
 * write-evidence-data.ts — static contract data for the evidence pair:
 * claim lists, the Keep baseline, parity dispositions and exclusions,
 * shim-logic records, open findings and deviations. Kept separate so
 * write-evidence.ts stays under the max-lines cap.
 */

export const CLAIMS_NOT_MADE = [
  "qualified",
  "ready",
  "released",
  "channel chosen",
  "home chosen",
  "adopted by llamactl",
  "dual-consumer parity",
  "warm pooling is session resume",
];

/** Keep baseline — the origin pass counts this branch is pinned to. */
export const BASELINE_SET: Record<string, number> = {
  "packages/agentchat/test/adapters/cli-spawn.test.ts": 24,
  "packages/agentchat/test/adapters/cli-spawn-stream.test.ts": 14,
  "packages/agentchat/test/adapters/stdio-acp-client.test.ts": 11,
  "packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts": 6,
  "packages/agentchat/test/adapters/stdio-acp-server.test.ts": 5,
  "packages/agentchat/test/adapters/stdio-acp-permission.test.ts": 29,
  "packages/agentchat/test/adapters/acp-warm-pool.test.ts": 22,
  "packages/agentchat/test/cli": 71,
};

export interface Disposition {
  origin: string;
  parity: string | null;
  kind: "verbatim" | "re-expressed" | "context";
  excluded: { origin_title: string; module: string; reason: string }[];
  pointer: string;
}

const STREAM_EXCLUDED = [
  "GeminiCliAdapter.dispatchStream yields done with correct text",
  "ClaudeCliAdapter.dispatchStream yields done with correct text",
  "CodexCliAdapter.dispatchStream yields done with correct text",
  "dispatch() buffered path still returns correct text on GeminiCliAdapter",
];
const PERM_EXCLUDED = [
  "preserves the downstream terminal/create executor contract after allow_once",
];

export const DISPOSITIONS: Disposition[] = [
  {
    origin: "packages/agentchat/test/adapters/cli-spawn.test.ts",
    parity: "cli-spawn.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/cli-spawn.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/cli-spawn-stream.test.ts",
    parity: "cli-spawn-stream.test.ts",
    kind: "re-expressed",
    excluded: STREAM_EXCLUDED.map((t) => ({
      origin_title: t,
      module: "packages/agentchat/test/adapters/cli-spawn-stream.test.ts",
      reason: "vendor adapter class not extracted",
    })),
    pointer: "qualification/consumers/penumbra-host/test/cli-spawn-stream.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/stdio-acp-client.test.ts",
    parity: "stdio-acp-client.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/stdio-acp-client.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts",
    parity: "stdio-acp-client-onrequest.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/stdio-acp-client-onrequest.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/stdio-acp-server.test.ts",
    parity: "stdio-acp-server.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/stdio-acp-server.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/stdio-acp-permission.test.ts",
    parity: "stdio-acp-permission.test.ts",
    kind: "re-expressed",
    excluded: PERM_EXCLUDED.map((t) => ({
      origin_title: t,
      module: "packages/agentchat/test/adapters/stdio-acp-permission.test.ts",
      reason: "exercises only the non-extracted StdioAcpAdapter executor",
    })),
    pointer: "qualification/consumers/penumbra-host/test/stdio-acp-permission.parity.ts",
  },
  {
    origin: "packages/agentchat/test/adapters/acp-warm-pool.test.ts",
    parity: "acp-warm-pool.test.ts",
    kind: "verbatim",
    excluded: [],
    pointer: "qualification/consumers/penumbra-host/test/acp-warm-pool.parity.ts",
  },
  {
    origin: "packages/agentchat/test/cli",
    parity: null,
    kind: "context",
    excluded: [],
    pointer: "",
  },
];

export const BOUNDARY_TYPE_IMPORTS_REMOVED = [
  {
    file: "cli-spawn.ts (origin)",
    removed: "@penumbra/core (DispatchEventInput)",
    replaced_by: "generic supervision in process-supervisor.ts",
  },
  {
    file: "cli-spawn.ts (origin)",
    removed: "@src/sdk/adapter.js (DispatchEvent)",
    replaced_by: "onProcessEvent callback on ExecSupervisor",
  },
  {
    file: "cli-spawn.ts (origin)",
    removed: "@src/worker/thought-capture.js",
    replaced_by: "removed — thought capture is host-side",
  },
  {
    file: "stdio-acp-permission.ts",
    removed: "@src/sdk/adapter.js (DispatchInput)",
    replaced_by: "PermissionHost — host passes signal, dispatchId, decide, logger",
  },
  {
    file: "acp-warm-pool.ts",
    removed: "@src/adapters/stdio-acp-client.js (type-level)",
    replaced_by: "AcpPoolClient structural type (no runtime import)",
  },
  {
    file: "stdio-acp-server.ts",
    removed: "console.error + stderr tee",
    replaced_by: "ExecLogger + onStderrChunk callback",
  },
  {
    file: "stdio-acp-client.ts",
    removed: "console.*",
    replaced_by: "ExecLogger",
  },
];

export const SHIM_LOGIC = [
  {
    area: "cli-spawn host shim (penumbra-host/src/shim/cli-spawn.ts)",
    logic:
      "ambient process.env merge, PENUMBRA_* env reads, DispatchEvent emission, output-cap text accumulator, strip_patterns, thoughtCapture stub",
    measured_by: "test/cli-spawn.parity.ts + test/cli-spawn-stream.parity.ts",
    status: "shim-side logic — its passes measure the shim, not a future llamactl binding",
  },
  {
    area: "acp-warm-pool host shim (penumbra-host/src/shim/acp-warm-pool.ts)",
    logic:
      "implements holder/release/canAddEntry/peekMissReason and mints a credential scope per deposit",
    measured_by: "test/acp-warm-pool.parity.ts (22 tests)",
    status: "inferred",
  },
];

export const OPEN_FINDINGS: Record<string, unknown>[] = [
  {
    finding: "T10 byte, request-count and backpressure limits are unmeasured (keeps B8 open)",
    status: "open",
    pointer: "blockers.B8",
  },
  {
    finding: "stderr bytes can appear inside an errors payload (the stderr-in-errors leak vector)",
    status: "open",
    pointer: "src/process-supervisor.ts stderr tail accumulation",
  },
  {
    finding: "generated .d.ts references node: builtins — consumer typecheck needs @types/node",
    status: "open",
    pointer: "qualification consumer devDependencies",
  },
  {
    finding: "detectCapacityError matches provider-specific stderr patterns only",
    status: "open",
    pointer: "src/process-supervisor.ts detectCapacityError",
  },
  {
    finding: "startStdioAcpServer is typed Promise but throws synchronously on a bad spawn",
    status: "open",
    pointer: "src/stdio-acp-server.ts",
  },
  {
    finding:
      "the cli-spawn adapter surface is folded into process-supervisor.ts, not a separate module",
    status: "open",
    pointer: "src/process-supervisor.ts",
  },
  {
    finding: "the Content-Length framing regex is unanchored",
    status: "open",
    pointer: "src/stdio-acp-client.ts",
  },
  {
    finding: "the pool key is NUL-joined and specHash is not validated against a digest grammar",
    status: "open",
    pointer: "src/acp-warm-pool.ts",
  },
  {
    finding: "method, toolName and dispatchId are written into logger fields",
    status: "open",
    pointer: "src/stdio-acp-client.ts, src/stdio-acp-permission.ts:393-395",
  },
  {
    finding: "the literal 'ignore' stdin option assumes every consumer wants the same default",
    status: "open",
    pointer: "src/process-supervisor.ts stdio config",
  },
  {
    finding:
      "the warm-pool parity passes measure a shim that implements holder/release/canAddEntry/peekMissReason and mints a scope per deposit",
    status: "inferred",
    would_confirm: "a delegation-only shim",
    pointer: "qualification/consumers/penumbra-host/src/shim/acp-warm-pool.ts",
  },
  {
    finding:
      'unpinned behaviours: abort-listener removal, cap-before-callback ordering, the ?? "reject" decide default, and the persistent stdio error listeners',
    status: "open",
    pointer: "src/process-supervisor.ts, src/stdio-acp-client.ts",
  },
  {
    finding:
      "the comment that no host code runs before addEventListener is wrong: n.now and n.timers run first and the post-registration aborted re-check was removed",
    status: "open",
    pointer: "src/process-supervisor.ts:555",
  },
  {
    finding:
      "the outcome is frozen before waitGroupGone resolves, so a watchdog kill of a detached group still reports outcome 'exited'",
    status: "open",
    pointer: "src/process-supervisor.ts waitGroupGone",
  },
  {
    finding:
      "record-only review items: no newline line bound; per-chunk Buffer.concat; no request() timeout; no close/dispose; the 4096 retired-id budget; the 64 KB rawInput deny; writeMessage ignores backpressure; unvalidated initialize and response shapes; the instanceof auth retry; ambient timers; bootDeadlineMs naming; the duplicate agentchat stack",
    status: "open",
    pointer: ".penumbra/reviews/2026-09-25T10-16-30.218Z/synthesis.md",
  },
  {
    finding:
      "skipLibCheck:true in the generated tsconfig.consumer.json may hide .d.ts errors inside the installed package surface",
    status: "open",
    pointer: "scripts/qualify.ts copyConsumer tsconfig",
  },
];

export const STATIC_DEVIATIONS: Record<string, unknown>[] = [
  {
    rule: "infra-host consumer language",
    change: "TypeScript sources (src/*.ts, test/infra.parity.ts) rather than plain .mjs sources",
    reason:
      "the qualification contract requires test/*.parity.ts plus typescript and @types/node devDependencies; node runs the .ts smoke via native type-stripping, so the no-toolchain property is preserved",
    pointer: "qualification/consumers/infra-host",
  },
  {
    rule: "vendor-dir consumer installs",
    change:
      "consumers are copied to tmp/sharedlib6/consumer-<name>/ and install the packed tarball via bun add",
    reason:
      "a tracked vendor/ directory and file: dependency let workspace resolution mask a broken packed-package install; the tmp copy makes missing isolation impossible to hide",
    pointer: "scripts/qualify.ts",
  },
  {
    rule: "sidecar verdict file",
    change: "removed; the composite derives its verdict from per-gate exits",
    reason: "a hidden verdict file let earlier runs print a pass while real gates had failed",
    pointer: "scripts/sharedlib6-check.ts",
  },
  {
    rule: "single-owner.test.ts port",
    change:
      "module-identity and closure-audit-hook tests stay repo-side; the namespace assertion is re-expressed as test/exports.parity.ts",
    reason:
      "module-instance identity and the audit script do not exist inside an installed consumer",
    pointer: "qualification/contract-port.ts",
  },
  {
    rule: "comment-only bunfig in consumer copies",
    change: "consumers ship a comment-only bunfig.toml",
    reason: "a preload bunfig would run inside every spawned bun child of the suite",
    pointer: "qualification/consumers/*/bunfig.toml",
  },
  {
    rule: "two-file re-expression split",
    change: "closure-audit.ts is split into closure-audit.ts + closure-audit-core.ts",
    reason: "the 700-line cap",
    pointer: "scripts/closure-audit-core.ts",
  },
  {
    rule: "extra audit fixtures",
    change:
      "b-const-annotated-array, b-const-object-literal, b-const-arrow-map, b-const-arrow-record and d-consumer-guard-dynamic-import added; audit-allowlist-dist.json audits the dist bundle separately",
    reason:
      "the mutable-binding rule grew per-shape tokens and arrow-type annotations; the consumer guard-tripwire shape needed a src-side negative case",
    pointer: "qualification/audit-fixtures/",
  },
];

export function blockerMap(): Record<string, { status: string; evidence: string }> {
  return {
    B1: {
      status: "resolved",
      evidence:
        "private:true retained in package.json and in the packed manifest (no publish path)",
    },
    B3: {
      status: "resolved",
      evidence:
        "[B3] env-boundary tests pass: the child env is the verbatim host env plus a computed PATH; mutation a (ambient merge) breaks the suite as measured",
    },
    B4: {
      status: "resolved",
      evidence:
        "[B4] cancel-grace and watchdog tests pass; mutations d and f (hardcoded defaults) break the suite as measured",
    },
    B6: {
      status: "resolved",
      evidence:
        "[B6]/[ACP-CLIENTINFO] pass: initialize advertises the host clientInfo verbatim; mutation e breaks the suite as measured",
    },
    B7: {
      status: "resolved",
      evidence:
        "[B7]/[SCOPE-2] pass: pool keys include credential scope; mutation b (digestless key) breaks the suite as measured",
    },
    B8: {
      status: "open",
      evidence:
        "[B8] closed-transport rejection passes in both consumers, but the T10 (byte/request-count/backpressure limits) and T14 residual limits are unmeasured — recorded in open_findings",
    },
    B10: {
      status: "resolved",
      evidence:
        "zero mutable module-scope bindings under the audit; callback-failure and malformed-stream tests pass; T13 ([B10]) green",
    },
  };
}
