# Qualification — penumbra-exec-primitives (P2.2 / sharedlib6)

Evidence-only qualification of the shared execution-primitives candidate
extracted from `packages/agentchat/src/adapters/`. This report asserts nothing
about adoption, release, publication, package home, or registry state. Every
tarball mention below refers to a local channel stand-in, never a versioned
channel.

Commit: `ab0903bd56419ee1a6b8bdebb74dd64a4b41e35a` (head_sha: the commit this evidence was written against; the evidence commit itself lands on top) — base: `c264644bc2b4f1e1429e845208fd6ca7f6426d62`
Toolchain: bun 1.3.14 · node v26.0.0 · typescript 6.0.3
Generated: 2026-09-26T01:24:20.077Z
Result (derived): PASS

Superseded evidence: commit `eac2182fe` carries an earlier evidence pair (its dist audit exited 1); it stays in branch history, this pair supersedes it, and the PR merge squashes it away.

## Verdicts

- L1: PASS
- L2: PASS (stand-in)
- L3: DEFERRED (penumbra=PASS, synthetic=PASS, llamactl=DEFERRED → P2.2/llamactl-adoption)
- L4: PASS
- L5: PASS
- L6: PASS

## Check steps

| Step | Log | Result |
| --- | --- | --- |
| `typecheck` | `check-logs/check-typecheck.log` | exit 0 |
| `dist-freshness` | `check-logs/check-dist-freshness.log` | exit 0 |
| `typecheck-coverage` | `check-logs/check-typecheck-coverage-ratchet.log,check-logs/check-typecheck-coverage-files.log` | exit 0 |
| `lint-guards` | `check-logs/check-lint-no-raw-env.log,check-logs/check-lint-no-sync-exec.log` | exit 0 |
| `eslint` | `check-logs/check-eslint.log` | exit 0 |
| `prettier` | `check-logs/check-prettier.log` | exit 0 |
| `test-gate` | `check-logs/check-bun-test-gate.log,check-logs/check-suite-tags.log` | exit 0 · 73p/0f |
| `mutations` | `check-logs/check-mutations.log` | exit 0 |
| `section2-slice` | `check-logs/check-section2-slice.log` | exit 0 |
| `closure-audit-src` | `check-logs/check-closure-audit-src.log` | exit 0 |
| `qualify` | `check-logs/check-qualify.log` | exit 0 |
| `closure-audit-tarball` | `check-logs/check-closure-audit-tarball.log` | exit 0 |
| `fence` | `check-logs/check-fence.log` | exit 0 |
| `root-lint` | `check-logs/check-root-lint.log` | exit 1 (non-gating) |

## L1

Verdict: PASS (scope: branch)

Evidence:
  - src/ audits clean (specifiers, tokens, mutable bindings, allowlist) — confirmed (`tmp/sharedlib6/check-logs/check-closure-audit-src.log`)
  - self-test passes over the fixture set — confirmed (`tmp/sharedlib6/check-logs/check-precheck-closure-self-test.log`)
  - audit counts recorded: files=8, lines=2262, runtime specifiers=15, type-only=6 — confirmed (`tmp/sharedlib6/check-logs/check-closure-audit-src.log`)
  - dist/ audits clean under the same rules plus the dist allowlist — confirmed (`tmp/sharedlib6/check-logs/check-closure-audit-tarball.log`)

Not provable here:
  - that the audit token list covers every future forbidden pattern — only the fixture shapes are proven
  - that the dist bundle cannot hide behaviour the source audit missed — the tarball (channel stand-in) audit runs over dist/src, not the bundler

## L2 packed artifact (channel stand-in)

Both consumers ran inside this worktree against a locally packed tarball used as a channel stand-in — nothing here asserts a versioned channel, a package home, or a llamactl-side install.

Verdict: PASS (scope: branch)

Evidence:
  - the packed tarball (channel stand-in) installs into both consumer copies — confirmed (`tmp/sharedlib6/measurements.json consumers.*.steps`)
  - manifest gate holds: no 0.0.0, no workspace/file/link specifiers, MIT license, entry whitelist — confirmed (`tmp/sharedlib6/measurements.json problems + tarball.entries`)
  - both copies resolve the package from inside the copy; installed content digest equals the tarball (channel stand-in) digest — confirmed (`tmp/sharedlib6/measurements.json consumers.*.resolved_to, digest_equal`)
  - runs without a Penumbra checkout, daemon, database, memory or config — inferred (`rule (a) over the extraction plus the @penumbra/* stub tripwire (tmp/sharedlib6/logs/*-guard.log) and empty isolated HOME (home_entries_after)`); would confirm: an install outside any checkout — owed to P2.2/llamactl-adoption
  - B1 resolved — private:true retained in the packed manifest (channel stand-in) — confirmed (`tmp/sharedlib6/pack/extracted/package/package.json`)

Not provable here:
  - a versioned channel — the locally packed tarball is a channel stand-in
  - a chosen home for the package
  - a llamactl-side install of the artifact
  - that either consumer ran outside this worktree

## L3

Verdict: DEFERRED (scope: branch)

Evidence:
  - penumbra part PASS — origin adapter suite ported to the packed artifact (channel stand-in) — confirmed (`tmp/sharedlib6/measurements.json consumers.penumbra-host.steps parity:*`)
  - synthetic part PASS — infra-host consumer suite — confirmed (`tmp/sharedlib6/measurements.json consumers.infra-host.steps`)

Not provable here:
  - a llamactl-side run — there is no llamactl consumer in this worktree
  - parity against any adapter surface other than the two consumers measured

## L4

Verdict: PASS (scope: branch)

Evidence:
  - package contract suite green under the bun test gate — confirmed (`tmp/sharedlib6/check-logs/check-bun-test-gate.log`)
  - all six mutation patches break the suite as measured, and the suite is green after revert — confirmed (`tmp/sharedlib6/mutations.json`)
  - B3, B4, B6, B7, B10 resolved by the same measurements — confirmed (`blockers in this document`)

Not provable here:
  - llamactl injecting its own values — env, timers, logger and decide come from the two stand-in hosts
  - host behaviours not pinned by the contract suite (open_findings records the list)

T7 overshoot: 131072 bytes past the 65536-byte limit (the `t7-overshoot=` marker the [B10] output-limit test prints into the gate log). It varies run to run with pipe chunking and stays within the largest chunk, so SHAPE binds it as a positive measurement rather than a fixed value.

## L5

Verdict: PASS (scope: branch)

Evidence:
  - every gating step before qualify.ts passed — confirmed (`check_steps in this document`)
  - the 6.2 manifest/content gate holds on the extracted tarball (channel stand-in) — confirmed (`tmp/sharedlib6/measurements.json problems + tarball.entries`)
  - version is 0.1.0, not 0.0.0 — confirmed (`tmp/sharedlib6/pack/extracted/package/package.json`)
  - root lint:strict omits packages/exec-primitives — the package lint gate is the eslint step recorded above — confirmed (`root package.json lint:strict script`)
  - root bun run lint recorded non-gating exit 1 — confirmed (`tmp/sharedlib6/check-logs/check-root-lint.log`)

Not provable here:
  - the versioned release — the version-0.1.0 local tarball is a channel stand-in
  - publication state, registry state, or a chosen home

## L6

Warm pooling is not a resume mechanism: the pool reuses idle child processes within one host process lifetime and carries no session state.

Verdict: PASS (scope: branch)

Evidence:
  - no allowlist entry names a real control-flow path — confirmed (`audit_allowlist_entries in this document`)
  - src and dist audits clean under (b) and (c) — confirmed (`tmp/sharedlib6/check-logs/check-closure-audit-*.log`)
  - T15 ([L6] module identity) and T9 ([B7] warm-pool tests) pass — confirmed (`tmp/sharedlib6/check-logs/check-bun-test-gate.log`)
  - warm pooling is not a resume mechanism — stated in the report — confirmed (`the L6 section of the accompanying .md`)

Not provable here:
  - a real llamactl worker — warm pooling is measured against two stand-in hosts
  - that the allowlist can never hide a future control-flow entry — the classification rule is enforced per entry

## Mutations

6 patches; clean after revert: `true`.

| Patch | Intent | Detection |
| --- | --- | --- |
| a-env-base.patch | spawn merges ambient process.env under the host env | detected (3 failing; expected-detectors true; post-revert-green true) |
| b-digestless-key.patch | poolKeyFor omits credentialScope from the key | detected (2 failing; expected-detectors true; post-revert-green true) |
| c-unguarded-request.patch | request() no longer rejects on a closed transport | detected (3 failing; expected-detectors true; post-revert-green true) |
| d-grace-default.patch | cancelGraceMs is replaced by the constant 10000 | detected (4 failing; expected-detectors true; post-revert-green true) |
| e-hardcoded-clientinfo.patch | initialize advertises a literal clientInfo instead of the host's | detected (1 failing; expected-detectors true; post-revert-green true) |
| f-watchdog-default.patch | watchdogMs is replaced by the constant 5000 | detected (6 failing; expected-detectors true; post-revert-green true) |

## RED/GREEN

RED is the package suite with the patch applied; GREEN is the same suite after
the revert, and the last column counts the tag's titles passing in the gate log.

| Tag | Patch | RED (suite under the patch) | GREEN (after revert) | [tag] passing in gate |
| --- | --- | --- | --- | --- |
| [B3] | a-env-base.patch | 3 failing / 73 ran (exit 1) | green | 6 |
| [B7] | b-digestless-key.patch | 2 failing / 73 ran (exit 1) | green | 7 |
| [B8] | c-unguarded-request.patch | 3 failing / 73 ran (exit 1) | green | 11 |
| [B4] | d-grace-default.patch | 4 failing / 73 ran (exit 1) | green | 4 |
| [B6] | e-hardcoded-clientinfo.patch | 1 failing / 73 ran (exit 1) | green | 7 |
| [B4] | f-watchdog-default.patch | 6 failing / 73 ran (exit 1) | green | 4 |

## Tarball (channel stand-in)

`penumbra-exec-primitives-0.1.0.tgz` — 19 files, 76336 bytes unpacked. This tarball is a local channel stand-in.

- `sha256(tgz) = 8896877b9666bb56b427aacc20197be7a740e68f6c1d93ba305c8f392d621975`
- `content_sha256 = 7f5d49b3771b272a8b044d1dfde8de8fe972f5a7652c5dff8c3c68f52904cb5e` (sorted-path content digest of the unpacked tree)
- repack determinism: two independent `bun pm pack` runs → byte_reproducible=true
- entries: 19 (package.json, LICENSE, README.md, dist/src/** only)

## Consumers

Each consumer fixture is copied to `tmp/sharedlib6/consumer-<name>/` and installs
the packed tarball (channel stand-in) via `bun add` under an isolated HOME and bun
cache, against a poisoned `@penumbra/*` resolution layer so a workspace link can
never mask a missing install. The install fetched typescript and @types/node from
the registry (`network_required: true`); the runtime steps ran with dead proxy
variables.

| Host | Runtime | Install | Resolved to | Steps |
| ---- | --- | --- | --- | --- |
| penumbra-host | bun 1.3.14 | `bun add ../pack/penumbra-exec-primitives-0.1.0.tgz` | `tmp/sharedlib6/consumer-penumbra-host/node_modules/penumbra-exec-primitives/dist/src/index.js` | contract-port exit 0 · bun-add exit 0 · typecheck exit 0 · smoke-bun exit 0 · parity:acp-warm-pool.test.ts exit 0 (22p/0f) · parity:cli-spawn.test.ts exit 0 (24p/0f) · parity:cli-spawn-stream.test.ts exit 0 (10p/0f) · parity:exports.test.ts exit 0 (1p/0f) · parity:guard.test.ts exit 0 (1p/0f) · parity:stdio-acp-client.test.ts exit 0 (11p/0f) · parity:stdio-acp-client-onrequest.test.ts exit 0 (6p/0f) · parity:stdio-acp-permission.test.ts exit 0 (28p/0f) · parity:stdio-acp-server.test.ts exit 0 (5p/0f) · bun-test exit 0 (178p/0f) · guard exit 0 |
| infra-host | bun 1.3.14 + node v26.0.0 | `bun add ../pack/penumbra-exec-primitives-0.1.0.tgz` | `tmp/sharedlib6/consumer-infra-host/node_modules/penumbra-exec-primitives/dist/src/index.js` | bun-add exit 0 · typecheck exit 0 · smoke-bun exit 0 · smoke-node exit 0 · parity:infra.test.ts exit 0 (21p/0f) · bun-test exit 0 (21p/0f) · guard exit 0 |

Installed-content digest equals the tarball (channel stand-in) digest for each
consumer (`digest_equal`), `home_entries_after` is empty for both isolated
HOMEs, and the per-copy poison run passes 0 tests against the broken entry.

## Section 2 — adapter-surface parity vs `packages/agentchat/`

Origin slices are measured fresh each run (`section2-slice.ts`); parity counts
come from the per-file parity steps inside the penumbra-host consumer copy.
Baseline and after carry a delta of 0.

| Origin | Disposition | Origin result | Parity result | Exclusions | Verdict |
| --- | --- | --- | --- | --- | --- |
| `packages/agentchat/test/adapters/cli-spawn.test.ts` | verbatim | 24p/0f (24 ran) | `cli-spawn.test.ts` → 24p/0f | — | consistent |
| `packages/agentchat/test/adapters/cli-spawn-stream.test.ts` | re-expressed | 14p/0f (14 ran) | `cli-spawn-stream.test.ts` → 10p/0f | 4 excluded (vendor adapter class not extracted, …) | consistent |
| `packages/agentchat/test/adapters/stdio-acp-client.test.ts` | verbatim | 11p/0f (11 ran) | `stdio-acp-client.test.ts` → 11p/0f | — | consistent |
| `packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts` | verbatim | 6p/0f (6 ran) | `stdio-acp-client-onrequest.test.ts` → 6p/0f | — | consistent |
| `packages/agentchat/test/adapters/stdio-acp-server.test.ts` | verbatim | 5p/0f (5 ran) | `stdio-acp-server.test.ts` → 5p/0f | — | consistent |
| `packages/agentchat/test/adapters/stdio-acp-permission.test.ts` | re-expressed | 29p/0f (29 ran) | `stdio-acp-permission.test.ts` → 28p/0f | 1 excluded (exercises only the non-extracted StdioAcpAdapter executor) | consistent |
| `packages/agentchat/test/adapters/acp-warm-pool.test.ts` | verbatim | 22p/0f (22 ran) | `acp-warm-pool.test.ts` → 22p/0f | — | consistent |
| `packages/agentchat/test/cli` | context | 71p/0f (71 ran) | context slice (not ported) | — | consistent |

Per-file parity table (baseline_tests = ported + not_portable; SHAPE binds each
count to the section-2 baseline, the parity step and excluded_cases):

| Origin | baseline_tests | ported | passed | not_portable | adaptations | reason |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/agentchat/test/adapters/cli-spawn.test.ts` | 24 | 24 | 24 | 0 | 3 | verbatim port — titles preserved |
| `packages/agentchat/test/adapters/cli-spawn-stream.test.ts` | 14 | 10 | 10 | 4 | 8 | re-expressed — parity titles carry the [re-expressed] marker and vendor-adapter cases are excluded |
| `packages/agentchat/test/adapters/stdio-acp-client.test.ts` | 11 | 11 | 11 | 0 | 1 | verbatim port — titles preserved |
| `packages/agentchat/test/adapters/stdio-acp-client-onrequest.test.ts` | 6 | 6 | 6 | 0 | 1 | verbatim port — titles preserved |
| `packages/agentchat/test/adapters/stdio-acp-server.test.ts` | 5 | 5 | 5 | 0 | 1 | verbatim port — titles preserved |
| `packages/agentchat/test/adapters/stdio-acp-permission.test.ts` | 29 | 28 | 28 | 1 | 7 | re-expressed — parity titles carry the [re-expressed] marker and vendor-adapter cases are excluded |
| `packages/agentchat/test/adapters/acp-warm-pool.test.ts` | 22 | 22 | 22 | 0 | 3 | verbatim port — titles preserved |

Excluded origin executions (exercising surfaces deliberately not extracted):
- `packages/agentchat/test/adapters/cli-spawn-stream.test.ts` — "GeminiCliAdapter.dispatchStream yields done with correct text" — vendor adapter class not extracted
- `packages/agentchat/test/adapters/cli-spawn-stream.test.ts` — "ClaudeCliAdapter.dispatchStream yields done with correct text" — vendor adapter class not extracted
- `packages/agentchat/test/adapters/cli-spawn-stream.test.ts` — "CodexCliAdapter.dispatchStream yields done with correct text" — vendor adapter class not extracted
- `packages/agentchat/test/adapters/cli-spawn-stream.test.ts` — "dispatch() buffered path still returns correct text on GeminiCliAdapter" — vendor adapter class not extracted
- `packages/agentchat/test/adapters/stdio-acp-permission.test.ts` — "preserves the downstream terminal/create executor contract after allow_once" — exercises only the non-extracted StdioAcpAdapter executor

Boundary imports removed (per extraction contract):

| Adapter source | Removed import | Replaced by |
| --- | --- | --- |
| `cli-spawn.ts` | `@penumbra/core` (DispatchEventInput), `@src/sdk/adapter.js` (DispatchEvent), `@src/worker/thought-capture.js` | generic supervision in `process-supervisor.ts` |
| `stdio-acp-permission.ts` | `@src/sdk/adapter.js` (DispatchInput) | `PermissionHost` — host passes `signal`, `dispatchId`, `decide`, `logger` |
| `stdio-acp-server.ts` | none (was already local) | `console.error` → `logger`; stderr tee → `onStderrChunk` callback |
| `stdio-acp-client.ts` | none | `console.*` → `ExecLogger`; close-guards added |
| `acp-warm-pool.ts` | `@src/adapters/stdio-acp-client.js` (type-level) | `AcpPoolClient` structural type (no runtime import) |

## Deviations

| Rule | Change | Reason | Pointer |
| --- | --- | --- | --- |
| infra-host consumer language | TypeScript sources (src/*.ts, test/infra.parity.ts) rather than plain .mjs sources | the qualification contract requires test/*.parity.ts plus typescript and @types/node devDependencies; node runs the .ts smoke via native type-stripping, so the no-toolchain property is preserved | `qualification/consumers/infra-host` |
| vendor-dir consumer installs | consumers are copied to tmp/sharedlib6/consumer-<name>/ and install the packed tarball (channel stand-in) via bun add | a tracked vendor/ directory and file: dependency let workspace resolution mask a broken install of the tarball (channel stand-in); the tmp copy makes missing isolation impossible to hide | `scripts/qualify.ts` |
| sidecar verdict file | removed; the composite derives its verdict from per-gate exits | a hidden verdict file let earlier runs print a pass while real gates had failed | `scripts/sharedlib6-check.ts` |
| single-owner.test.ts port | module-identity and closure-audit-hook tests stay repo-side; the namespace assertion is re-expressed as test/exports.parity.ts | module-instance identity and the audit script do not exist inside an installed consumer | `qualification/contract-port.ts` |
| comment-only bunfig in consumer copies | consumers ship a comment-only bunfig.toml | a preload bunfig would run inside every spawned bun child of the suite | `qualification/consumers/*/bunfig.toml` |
| closure-audit split | closure-audit.ts is split into closure-audit.ts + closure-audit-core.ts | the 700-line cap | `scripts/closure-audit-core.ts` |
| mutation error count | a mutated suite may report errors up to its failing-test count; errors beyond that fail the loop | bun counts a timed-out test as both a fail and an error, so requiring 0 errors would reject every timeout detector | `scripts/run-mutations.ts countsProblems` |
| SHAPE mutations[].errors binding | SHAPE compares every mutation field exactly except errors, which it binds to 0..failing on both sides | errors is bun's timeout attribution and depends on scheduling; with the loop green, the failing set, fail, pass and ran are already fixed, so errors is the one field that can move | `scripts/sharedlib6-shape-measured.ts mutationDiffs` |
| SHAPE t7_overshoot_bytes binding | SHAPE binds gates[L4].measurements.t7_overshoot_bytes as a positive measured overshoot, not by equality | the overshoot varies with pipe chunking (131072 in 6 and 196608 in 4 of 10 measured runs), so equality would fail at random | `scripts/sharedlib6-shape-bind.ts t7Reasons` |
| extra audit fixtures | b-const-annotated-array, b-const-object-literal, b-const-arrow-map, b-const-arrow-record and d-consumer-guard-dynamic-import added; audit-allowlist-dist.json audits the dist bundle separately | the mutable-binding rule grew per-shape tokens and arrow-type annotations; the consumer guard-tripwire shape needed a src-side negative case | `qualification/audit-fixtures/` |

## Open findings

- `t10-limits` [open] T10 byte, request-count and backpressure limits are unmeasured (keeps B8 open)
- `stderr-in-errors` [open] stderr bytes can appear inside an errors payload (the stderr-in-errors leak vector)
- `dts-needs-types-node` [open] generated .d.ts references node: builtins — consumer typecheck needs @types/node
- `detect-capacity-provider-specific` [open] detectCapacityError matches provider-specific stderr patterns only
- `stdio-acp-server-sync-throw` [open] startStdioAcpServer is typed Promise but throws synchronously on a bad spawn
- `cli-spawn-folded` [open] the cli-spawn adapter surface is folded into process-supervisor.ts, not a separate module
- `content-length-unanchored` [open] the Content-Length framing regex is unanchored
- `pool-key-nul-joined` [open] the pool key is NUL-joined and specHash is not validated against a digest grammar
- `log-field-identifiers` [open] method, toolName and dispatchId are written into logger fields
- `stdin-ignore-literal` [open] the literal 'ignore' stdin option assumes every consumer wants the same default
- `warm-pool-shim-logic` [inferred] the warm-pool parity passes measure a shim that implements holder/release/canAddEntry/peekMissReason and mints a scope per deposit (would confirm: a delegation-only shim)
- `unpinned-behaviours` [open] unpinned behaviours: abort-listener removal, cap-before-callback ordering, the ?? "reject" decide default, and the persistent stdio error listeners
- `abort-listener-comment` [open] the comment that no host code runs before addEventListener is wrong: n.now and n.timers run first and the post-registration aborted re-check was removed
- `outcome-frozen-before-group-gone` [open] the outcome is frozen before waitGroupGone resolves, so a watchdog kill of a detached group still reports outcome 'exited'
- `review-record-only` [open] record-only review items: no newline line bound; per-chunk Buffer.concat; no request() timeout; no close/dispose; the 4096 retired-id budget; the 64 KB rawInput deny; writeMessage ignores backpressure; unvalidated initialize and response shapes; the instanceof auth retry; ambient timers; bootDeadlineMs naming; the duplicate agentchat stack
- `consumer-skiplibcheck` [open] skipLibCheck:true in the generated tsconfig.consumer.json may hide .d.ts errors inside the installed package surface
- `b10-logger-stdio-acp-client` [inferred] host logger calls outside the supervisor are unguarded (B10 class): by code reading, a throwing logger in breakFraming leaves a pending request unsettled with the transport open, and a throwing handler plus a throwing logger leaves the peer request unanswered with an unhandled rejection (would confirm: a [B10] test driving each path with a throwing logger)
- `b10-logger-stdio-acp-permission` [inferred] the permission-failure catch block calls host.logger.warn unguarded before setting the reject decision (B10 class); by code reading, a throwing logger escapes the catch instead of rejecting (would confirm: a [B10] test with a throwing decide and a throwing logger)
- `b10-logger-stdio-acp-server` [inferred] the spawn-error paths call logger.error unguarded (B10 class); by code reading, a throwing logger at :95 throws out of startStdioAcpServer and at :102 rejects an unobserved promise (would confirm: a [B10] test spawning a missing command with a throwing logger)
- `b10-logger-acp-warm-pool` [inferred] crashed-entry teardown logs through an unguarded logger before teardownEntry runs (B10 class); by code reading, a throwing logger skips the teardown and leaves the crashed entry pooled (would confirm: a [B10] test crashing a pooled entry with a throwing logger)
- `b10-timers-orphan` [inferred] a throwing or non-function host timers.setTimeout makes superviseProcess throw after spawn and leaves the spawned child running; post-spawn setup has no kill-on-throw (seen by an independent verification probe, not measured on this branch) (would confirm: a [B10] test injecting a throwing timers.setTimeout)
- `mutation-loop-timing` [open] the mutation-loop comparison is timing-sensitive: an independent verification saw one SHAPE mismatch in about eleven green-tree runs, and composite run 1 at de407cc83 hit it again with every step green; the differing field was not captured (the run deletes its logs), while 4 isolated loops and 12 loaded suite runs of mutations d and f matched the evidence exactly. SHAPE now names the differing mutation and field and binds errors to 0..failing
- `parity-adaptations-incomplete` [open] parity.per_file adaptations[] pairs single-line import/export lines by position; it misses multi-line import closers and omits the helper and fixture diffs
- `root-lint-qualification-errors` [open] root `bun run lint` (non-gating) reports 28 errors in 12 files under packages/exec-primitives/qualification/**, which the package lint gate does not cover

## Claims not made

- qualified
- ready
- released
- channel chosen
- home chosen
- adopted by llamactl
- dual-consumer parity
- warm pooling is session resume

## Reproduce

```sh
bun install --frozen-lockfile
bun packages/exec-primitives/scripts/sharedlib6-check.ts --keep
bun packages/exec-primitives/scripts/write-evidence.ts
bun packages/exec-primitives/scripts/sharedlib6-shape-selftest.ts
```

## Scope

The packed tarball exercised here is a local channel stand-in. Parity is
bounded by the suites actually executed and recorded above; nothing about
distribution, hosting, or downstream adoption follows from this record.
