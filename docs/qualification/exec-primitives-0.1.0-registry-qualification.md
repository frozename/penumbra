## L2 registry install

Verdict: PASS. The published tarball at https://registry.npmjs.org/@novaproto/exec-primitives/-/exec-primitives-0.1.0.tgz installs from the public npm registry with exact-pinned specifier 0.1.0 in a private test consumer. The artifact hashes (sha256, sha1, sha512), file count, unpacked bytes, content digest, manifest pin, lock entry, and dist-tags.latest are measured by the runner. The llamactl-side install is inferred here from the record pointer docs/qualification/exec-primitives-0.1.0-test-consumer.json until that record lands on main.

## L3 parity

Verdict: PASS (penumbra+synthetic). The penumbra-host consumer passes 178 tests across 15 files (108 parity plus 70 contract-port tests), and the infra-host consumer passes 21 tests across 1 file, both against the registry-installed package. The llamactl consumer part is inferred from the llamactl record pointer and is not re-run here.

## ACP primitives

| id | primitive | suites (penumbra-host) | infra-host ids |
| --- | --- | --- | --- |
| stdio-json-rpc-client | the stdio JSON-RPC client (with framing caps) | stdio-acp-client.test.ts (11), stdio-acp-client-onrequest.test.ts (6), contract/acp-transport.test.ts (11) | [B8], [ACP-CLIENTINFO] |
| process-server | the process server (process-group supervision) | stdio-acp-server.test.ts (5), cli-spawn.test.ts (24), cli-spawn-stream.test.ts (10), contract/process-supervisor.test.ts (33) | [T1], [T4], [T6], [T7] |
| permission-context | the permission context | stdio-acp-permission.test.ts (28), contract/acp-permission.test.ts (9) | [PERM-DENY], [PERM] |
| pool-credential-scope | the pool (host key including a credential-scope digest) | acp-warm-pool.test.ts (22), contract/acp-warm-pool.test.ts (7) | [SCOPE-2], [WARM-POOL] |
| session-bootstrap | a host-parameterized session bootstrap with host-supplied clientInfo | contract/acp-session.test.ts (7) | [ACP-CLIENTINFO], [B6] |

## Evidence of record

The evidence of record is tag qualification/sharedlib6-2026-09-24 (commit 001e12fc79c40d6c3c3a5fdf106d96d420f4c997, head fb4e560078baaf9177eb32a44ea0d29186edfa4a). For source identity, the runner measures the 8 src blob ids at the tag; the nova release side (e1a65bd77710afb4b3cf67909bd1984bf80837b1) is carried here as the copied release constant from check P2-28 pending closure verification V4a. Gates L1, L4, L5, L6 are carried forward from the evidence of record through source identity plus dist identity.
Open inferred items: source identity against the nova release is pending closure verification V4a; dist identity is pending closure verification V4b; the llamactl record pointer is pending check L item L-37 and closure verification V3.

## Claims not made

- adopted by llamactl
- 1830 closed
- penumbra agentchat migrated
- ACP fixture parity in the llamactl consumer (scoped to the llamactl consumer only; the ACP primitives themselves are qualified here)

## Reproduce

Run `bun packages/exec-primitives-consumer/scripts/registry-qualify.ts` from the repo root, then `bun packages/exec-primitives-consumer/scripts/registry-qualify.ts --write-evidence` to regenerate this record.
The 2026-09-24 record reproduces only at the tag, because main no longer carries its harness.
