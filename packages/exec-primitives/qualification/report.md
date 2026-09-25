# Qualification report — `penumbra-exec-primitives` (SLICE P2.2 / sharedlib6)

Evidence-only qualification of the shared execution-primitives candidate
extracted from `packages/agentchat/src/adapters/`. This report asserts nothing
about adoption, release, publication, package home, or registry state. The
local tarball below is a channel stand-in used only to prove the packed bits
work when installed into a host.

Base: `c264644bc2b4f1e1429e845208fd6ca7f6426d62`
Toolchain: bun 1.3.14 · node v26.0.0 · typescript 6.0.3

## Gates

| Gate           | Evidence                                                                                     | Result                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Contract suite | `evidence/green-run.txt`                                                                     | 43 pass / 0 fail (7 files)                                                                           |
| RED→GREEN      | `evidence/red-run.txt` (C2: 40 fail / 3 pass) → green-run                                    | Confirmed                                                                                            |
| Closure audit  | `evidence/closure-audit.txt`                                                                 | 8 files, 7 runtime specifiers (all `node:*`/relative), 0 mutable module-scope bindings, 0 violations |
| Typecheck      | `bun run build` (tsc --build) + root `bun scripts/check-dist-freshness.ts && tsc --build`    | exit 0                                                                                               |
| Mutations      | `evidence/mutations.json`                                                                    | 6/6 detected, `clean_after: true`                                                                    |
| Consumers      | `evidence/consumers.json`, `evidence/penumbra-host-test.log`, `evidence/infra-host-test.log` | see below                                                                                            |

Mutations (all detected by the contract suite):
m1 cancel→immediate SIGKILL (2 failing), m2 `process.env` merge leak (3),
m3 closed-transport guard removed (1), m4 auth retry disabled (1),
m5 credential scope dropped from pool key (2), m6 decide-throw→approve (1).

## Tarball (channel stand-in)

`penumbra-exec-primitives-0.1.0.tgz` — 19 files, 63,038 bytes unpacked
(dist/src/_.js + _.d.ts, README, LICENSE).

- `sha256(tgz) = dc1a2d0b7153acdecc985c33ef8de7295e690d9a4a2cbd920f4f5be98ce31b06`
- `content_sha256 = 4e21a0e09f6b20fea32990b069f0e73583a8c222f0a01f4c6e863c973a517654` (sorted-path content digest of the unpacked tree)
- repack determinism: two independent `bun pm pack` runs → identical content digest

## Consumers

| Host            | Runtime      | Install                                     | Result                                                                                                                                                                  |
| --------------- | ------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `penumbra-host` | bun 1.3.14   | `file:` dep on unpacked tarball             | 67 pass / 0 fail — 40 ported contract tests + 26 parity tests + 1 installed-namespace test                                                                              |
| `infra-host`    | node v26.0.0 | vendored tarball via `node_modules` symlink | 9 pass / 0 fail — env verbatim, cancel escalation, input fail-closed, closed-transport error, pool isolation, permission default-cancel, full wire boot with auth retry |

infra-host runs plain `.mjs` under `node --test` — no Bun, no TypeScript, no
Penumbra imports — and completes a real spawned-subprocess ACP session
(initialize → authenticate retry → session/new → session/prompt) against
`fake-acp.mjs`.

## Parity vs `packages/agentchat/test/adapters/` (102 tests)

- Ported: 26 → all pass under the packed tarball (client 11, onrequest 6, server 5, permission-bounds 4).
- Not portable: 76 — `cli-spawn*` (38) need `SpawnOpts`/dispatch events/vendor adapter classes that were intentionally not extracted; permission adapter block (16) drives `StdioAcpAdapter`; warm-pool (22) targets the superseded key/refcount API. See `evidence/section-2-delta.md`.
- The 3 `single-owner` contract tests are repo-side only (module-instance identity + closure-audit script); the installed-namespace check is re-expressed in the consumer as `test/exports.test.ts`.

## Composite check

`bun qualification/sharedlib6-check.ts` → `PASS (exit=0)`; per-gate logs in
`tmp/sharedlib6-run/check-*.log`, verdict in `tmp/sharedlib6-run/check.exit`
and `evidence/check.json`.

## Blockers

None for qualification.

## Open findings (not blockers)

1. **Adapter-side adoption is unverified.** The penumbra-host shim proves the
   old surface is _expressible_ over the new API (logger→console, tee→stderr,
   env pass-through, aborted-signal pre-check), but no agentchat code was
   re-pointed. Rewiring `packages/agentchat` is out of scope for this slice.
2. **Cancel-vs-exec race.** `superviseProcess` accepts a `signal` but a host
   that cancels in the same tick as spawn can still SIGTERM a child before it
   installs its own handler. Consumers should gate cancellation on readiness
   (infra smoke does exactly this). Worth documenting in any real consumer.
3. **`spawnCliAdapterStream` has no generic counterpart** — a consumer needing
   streamed dispatch events must build on `superviseProcess` + its own event
   bus.
4. **Warm-pool API is not wire-compatible** with the old key/refcount shape;
   a migrating host must restructure call sites, not just re-import.
5. Tarball reproducibility is verified at the _content_ level; the `.tgz` byte
   stream embeds gzip metadata and need not be byte-identical across hosts.
