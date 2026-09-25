# Qualification — penumbra-exec-primitives (P2.2 / sharedlib6)

Evidence-only qualification of the shared execution-primitives candidate
extracted from `packages/agentchat/src/adapters/`. This report asserts nothing
about adoption, release, publication, package home, or registry state. The
local tarball is a channel stand-in used only to prove the packed bits work
when installed into a host.

Commit: `4864af39fb209797f530f4a22e1de03e865edcf0` — base: `c264644bc2b4f1e1429e845208fd6ca7f6426d62`
Toolchain: bun 1.3.14 · node v26.0.0 · typescript 6.0.3
Generated: 2026-09-25T15:19:43.331Z

## Gates

| Gate | Evidence (tmp/sharedlib6-run/) | Result |
| ---- | --- | --- |
| build+typecheck | check-build+typecheck.log | exit 0 |
| contract-suite | check-contract-suite.log | exit 0 · 60 pass / 0 fail |
| suite-tags | check-suite-tags.log | exit 0 |
| closure-audit-src | check-closure-audit-src.log | exit 0 |
| closure-audit-self-test | check-closure-audit-self-test.log | exit 0 |
| mutations | check-mutations.log | exit 0 |
| typecheck-coverage | check-typecheck-coverage.log | exit 0 |
| consumers | check-consumers.log | exit 0 |
| closure-audit-tarball | check-closure-audit-tarball.log | exit 0 |

## Mutations

6 patches, all detected, tree clean after revert (`clean_after: true`).

| Patch | Intent | Detection |
| --- | --- | --- |
| a-cancel-grace-sigkill.patch | cancel kills the group with SIGKILL immediately, skipping SIGTERM | detected (3 failing) |
| b-env-merge-ambient.patch | spawn merges ambient process.env under the host env | detected (3 failing) |
| c-request-open-guard.patch | request() no longer rejects on a closed transport | detected (3 failing) |
| d-auth-retry-removed.patch | session/new -32000 no longer triggers authenticate+retry | detected (1 failing) |
| e-pool-scope-dropped.patch | poolKeyFor omits credentialScope from the key | detected (2 failing) |
| f-decide-throw-approve.patch | a throwing decide maps to approve instead of reject | detected (1 failing) |

## Tarball (channel stand-in)

`penumbra-exec-primitives-0.1.0.tgz` — 19 files, 71733 bytes unpacked.

- `sha256(tgz) = dbf61f7ab3d2fd5ce721a5b3b015768592bf9c5c2b0cfa1f1611d71d6343df4a`
- `content_sha256 = 9f9faa816b8720dd443dded9d449ed760e3bed7bf637d036e84293a9a6f66d8a` (sorted-path content digest of the unpacked tree)
- repack determinism: two independent `bun pm pack` runs → repack_identical=true

## Consumers

| Host | Runtime | Install | Resolved to | Result |
| ---- | --- | --- | --- | --- |
| penumbra-host | bun 1.3.14 | file: vendored tarball | `packages/exec-primitives/qualification/consumers/penumbra-host/node_modules/penumbra-exec-primitives/dist/src/index.js` | contract 57p/0f · parity 106p/0f · smoke exit 0 |
| infra-host | bun + node v26.0.0 | file: vendored tarball | `packages/exec-primitives/qualification/consumers/infra-host/node_modules/penumbra-exec-primitives/dist/src/index.js` | parity 17p/0f · smoke node exit 0 / bun exit 0 |

The poison check verified each consumer resolves `penumbra-exec-primitives`
inside its own `node_modules` — the workspace-root link can never mask a
missing vendor install. infra-host runs plain `.mjs` sources (no Bun/TS
runtime coupling) and completes real spawned-subprocess ACP sessions
(initialize → authenticate retry → session/new → session/prompt) against
`fixtures/fake-acp.mjs`.

## Parity vs `packages/agentchat/test/adapters/`

- Ported verbatim over a local shim surface (src/shim/*): cli-spawn (24),
  stdio-acp-client (11), stdio-acp-client-onrequest (6), stdio-acp-server (5),
  acp-warm-pool (22) — 68 tests.
- Re-expressed against the extracted primitives (permission context + stream
  semantics the old adapter glued to Penumbra dispatch types): 38 tests in
  permission-and-stream.parity.ts.
- Contract suite ported to run against the packed bits via
  qualification/contract-port.ts (test/contract/, generated per run);
  single-owner stays repo-side (module-instance identity cannot survive a
  package boundary).
- See `2026-09-25-sharedlib6-section-2-delta.md` for the per-file disposition.

## Composite check

`bun scripts/sharedlib6-check.ts` → `PASS (exit=0)`; per-gate logs under
`tmp/sharedlib6-run/check-*.log`, verdict in `check.exit` + `check.json`.

## Scope of claim

Qualification only. No release, no publication, no production-readiness and no
llamactl or agentchat adoption is asserted. Parity is bounded by the suites
actually executed and recorded above.
