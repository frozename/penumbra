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
    id: "t10-limits",
    finding: "T10 byte, request-count and backpressure limits are unmeasured (keeps B8 open)",
    status: "open",
    pointer: "blockers.B8",
  },
  {
    id: "stderr-in-errors",
    finding: "stderr bytes can appear inside an errors payload (the stderr-in-errors leak vector)",
    status: "open",
    pointer: "src/process-supervisor.ts stderr tail accumulation",
  },
  {
    id: "dts-needs-types-node",
    finding: "generated .d.ts references node: builtins — consumer typecheck needs @types/node",
    status: "open",
    pointer: "qualification consumer devDependencies",
  },
  {
    id: "detect-capacity-provider-specific",
    finding: "detectCapacityError matches provider-specific stderr patterns only",
    status: "open",
    pointer: "src/process-supervisor.ts detectCapacityError",
  },
  {
    id: "stdio-acp-server-sync-throw",
    finding: "startStdioAcpServer is typed Promise but throws synchronously on a bad spawn",
    status: "open",
    pointer: "src/stdio-acp-server.ts",
  },
  {
    id: "cli-spawn-folded",
    finding:
      "the cli-spawn adapter surface is folded into process-supervisor.ts, not a separate module",
    status: "open",
    pointer: "src/process-supervisor.ts",
  },
  {
    id: "content-length-unanchored",
    finding: "the Content-Length framing regex is unanchored",
    status: "open",
    pointer: "src/stdio-acp-client.ts",
  },
  {
    id: "pool-key-nul-joined",
    finding: "the pool key is NUL-joined and specHash is not validated against a digest grammar",
    status: "open",
    pointer: "src/acp-warm-pool.ts",
  },
  {
    id: "log-field-identifiers",
    finding: "method, toolName and dispatchId are written into logger fields",
    status: "open",
    pointer: "src/stdio-acp-client.ts, src/stdio-acp-permission.ts:393-395",
  },
  {
    id: "stdin-ignore-literal",
    finding: "the literal 'ignore' stdin option assumes every consumer wants the same default",
    status: "open",
    pointer: "src/process-supervisor.ts stdio config",
  },
  {
    id: "warm-pool-shim-logic",
    finding:
      "the warm-pool parity passes measure a shim that implements holder/release/canAddEntry/peekMissReason and mints a scope per deposit",
    status: "inferred",
    would_confirm: "a delegation-only shim",
    pointer: "qualification/consumers/penumbra-host/src/shim/acp-warm-pool.ts",
  },
  {
    id: "unpinned-behaviours",
    finding:
      'unpinned behaviours: abort-listener removal, cap-before-callback ordering, the ?? "reject" decide default, and the persistent stdio error listeners',
    status: "open",
    pointer: "src/process-supervisor.ts, src/stdio-acp-client.ts",
  },
  {
    id: "abort-listener-comment",
    finding:
      "the comment that no host code runs before addEventListener is wrong: n.now and n.timers run first and the post-registration aborted re-check was removed",
    status: "open",
    pointer: "src/process-supervisor.ts:555",
  },
  {
    id: "outcome-frozen-before-group-gone",
    finding:
      "the outcome is frozen before waitGroupGone resolves, so a watchdog kill of a detached group still reports outcome 'exited'",
    status: "open",
    pointer: "src/process-supervisor.ts waitGroupGone",
  },
  {
    id: "review-record-only",
    finding:
      "record-only review items: no newline line bound; per-chunk Buffer.concat; no request() timeout; no close/dispose; the 4096 retired-id budget; the 64 KB rawInput deny; writeMessage ignores backpressure; unvalidated initialize and response shapes; the instanceof auth retry; ambient timers; bootDeadlineMs naming; the duplicate agentchat stack",
    status: "open",
    pointer: ".penumbra/reviews/2026-09-25T10-16-30.218Z/synthesis.md",
  },
  {
    id: "consumer-skiplibcheck",
    finding:
      "skipLibCheck:true in the generated tsconfig.consumer.json may hide .d.ts errors inside the installed package surface",
    status: "open",
    pointer: "scripts/qualify.ts copyConsumer tsconfig",
  },
  {
    id: "b10-logger-stdio-acp-client",
    finding:
      "host logger calls outside the supervisor are unguarded (B10 class): by code reading, a throwing logger in breakFraming leaves a pending request unsettled with the transport open, and a throwing handler plus a throwing logger leaves the peer request unanswered with an unhandled rejection",
    status: "inferred",
    would_confirm: "a [B10] test driving each path with a throwing logger",
    pointer: "src/stdio-acp-client.ts:309, :350, :372, :421",
  },
  {
    id: "b10-logger-stdio-acp-permission",
    finding:
      "the permission-failure catch block calls host.logger.warn unguarded before setting the reject decision (B10 class); by code reading, a throwing logger escapes the catch instead of rejecting",
    status: "inferred",
    would_confirm: "a [B10] test with a throwing decide and a throwing logger",
    pointer: "src/stdio-acp-permission.ts:393",
  },
  {
    id: "b10-logger-stdio-acp-server",
    finding:
      "the spawn-error paths call logger.error unguarded (B10 class); by code reading, a throwing logger at :95 throws out of startStdioAcpServer and at :102 rejects an unobserved promise",
    status: "inferred",
    would_confirm: "a [B10] test spawning a missing command with a throwing logger",
    pointer: "src/stdio-acp-server.ts:95, :102",
  },
  {
    id: "b10-logger-acp-warm-pool",
    finding:
      "crashed-entry teardown logs through an unguarded logger before teardownEntry runs (B10 class); by code reading, a throwing logger skips the teardown and leaves the crashed entry pooled",
    status: "inferred",
    would_confirm: "a [B10] test crashing a pooled entry with a throwing logger",
    pointer: "src/acp-warm-pool.ts:176",
  },
  {
    id: "b10-timers-orphan",
    finding:
      "a throwing or non-function host timers.setTimeout makes superviseProcess throw after spawn and leaves the spawned child running; post-spawn setup has no kill-on-throw (seen by an independent verification probe, not measured on this branch)",
    status: "inferred",
    would_confirm: "a [B10] test injecting a throwing timers.setTimeout",
    pointer: "src/process-supervisor.ts superviseProcess post-spawn timer setup",
  },
  {
    id: "mutation-loop-timing",
    finding:
      "the mutation-loop comparison is timing-sensitive: an independent verification saw one failure in about eleven green-tree runs, cause not captured; the watchdog and grace mutations (d, f) compare exact fail and error counts",
    status: "open",
    pointer: "scripts/run-mutations.ts, scripts/sharedlib6-shape-measured.ts shapeMutations",
  },
  {
    id: "parity-adaptations-incomplete",
    finding:
      "parity.per_file adaptations[] pairs single-line import/export lines by position; it misses multi-line import closers and omits the helper and fixture diffs",
    status: "open",
    pointer: "scripts/write-evidence.ts importAdaptations",
  },
];

/** The root `bun run lint` errors inside branch-added qualification/**,
 * counted from this run's root-lint step log (non-gating per the spec). */
export function rootLintFinding(measured: {
  errors: number;
  files: number;
}): Record<string, unknown> {
  return {
    id: "root-lint-qualification-errors",
    finding: `root \`bun run lint\` (non-gating) reports ${String(measured.errors)} errors in ${String(measured.files)} files under packages/exec-primitives/qualification/**, which the package lint gate does not cover`,
    status: "open",
    pointer:
      "tmp/sharedlib6/check-logs/check-root-lint.log; reproduce: NODE_OPTIONS=--max-old-space-size=8192 bunx eslint packages/exec-primitives/qualification",
    measured,
  };
}

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
      "consumers are copied to tmp/sharedlib6/consumer-<name>/ and install the packed tarball (channel stand-in) via bun add",
    reason:
      "a tracked vendor/ directory and file: dependency let workspace resolution mask a broken install of the tarball (channel stand-in); the tmp copy makes missing isolation impossible to hide",
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
    rule: "closure-audit split",
    change: "closure-audit.ts is split into closure-audit.ts + closure-audit-core.ts",
    reason: "the 700-line cap",
    pointer: "scripts/closure-audit-core.ts",
  },
  {
    rule: "mutation error count",
    change:
      "a mutated suite may report errors up to its failing-test count; errors beyond that fail the loop",
    reason:
      "bun counts a timed-out test as both a fail and an error, so requiring 0 errors would reject every timeout detector",
    pointer: "scripts/run-mutations.ts countsProblems",
  },
  {
    rule: "SHAPE t7_overshoot_bytes binding",
    change:
      "SHAPE binds gates[L4].measurements.t7_overshoot_bytes as a positive measured overshoot, not by equality",
    reason:
      "the overshoot varies with pipe chunking (131072 in 6 and 196608 in 4 of 10 measured runs), so equality would fail at random",
    pointer: "scripts/sharedlib6-shape-bind.ts t7Reasons",
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
        "private:true retained in package.json and in the packed manifest (channel stand-in); no publish path",
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
