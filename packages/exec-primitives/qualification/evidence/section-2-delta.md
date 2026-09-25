# Section 2 — surface delta: `packages/agentchat/src/adapters/*` → `penumbra-exec-primitives`

Scope: what the extraction changed, and which original-behavior surfaces are
intentionally not preserved. This is a qualification record, not an API contract
for any release.

## Boundary imports removed

| Adapter source            | Removed import                                                                                                     | Replaced by                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `cli-spawn.ts`            | `@penumbra/core` (`DispatchEventInput`), `@src/sdk/adapter.js` (`DispatchEvent`), `@src/worker/thought-capture.js` | File deleted; generic supervision extracted to `process-supervisor.ts`                |
| `stdio-acp-permission.ts` | `@src/sdk/adapter.js` (`DispatchInput`)                                                                            | `PermissionHost` — host passes `signal`, `dispatchId`, `trustAll`, `decide`, `logger` |
| `stdio-acp-server.ts`     | none (was already local)                                                                                           | `console.error` → `logger`; stderr tee → `onStderrChunk` callback                     |
| `stdio-acp-client.ts`     | none                                                                                                               | `console.*` → `ExecLogger`; close-guards added                                        |
| `acp-warm-pool.ts`        | `@src/adapters/stdio-acp-client.js` kept as a _type-level_ client shape                                            | `AcpPoolClient` structural type (no runtime import)                                   |

## Renamed / reshaped surfaces

| Before (agentchat)                                                                                         | After (exec-primitives)                                                                                | Note                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawnCliAdapter(opts: SpawnOpts)`                                                                         | `superviseProcess(opts: SuperviseOptions)`                                                             | Dispatch events, thought capture, SDK adapter types removed; `command` (was `binary`), `env`+`signal`+`cancelGraceMs`+`watchdogMs` are now **required** host inputs |
| `spawnCliAdapterStream`                                                                                    | not extracted                                                                                          | Streaming dispatch is Penumbra orchestration, not an execution primitive                                                                                            |
| `startStdioAcpServer({binary,...})`                                                                        | `startStdioAcpServer({command, env, signal, cancelGraceMs, ...})`                                      | Env defaults to nothing — host passes it explicitly; stderr is never teed to `process.stderr`                                                                       |
| `createAcpWarmPool()` key=`poolKeyFor({agent,cwd})`, `acquire(holderId,key,specHash)` + `release()` + refs | `acquire(spec)`/`deposit(spec, entry)` with `poolKeyFor(spec)` requiring `credentials.credentialScope` | Ownership-transfer semantics replace refcount; cross-credential reuse is impossible by construction                                                                 |
| `StdioAcpAdapter.dispatch` permission flow                                                                 | `handleStdioAcpPermissionRequest(host, context, wireRequest)`                                          | Adapter class not extracted; the wire handler + `StdioAcpPermissionContext` are                                                                                     |

## Behavior changes that are deliberate

- All Penumbra coupling removed: no `@penumbra/*`, no `@src/*`, no `process.env` reads, no `console.*`, no `process.stderr` writes in `src/` (enforced by `scripts/closure-audit.ts`).
- Environment is verbatim: the child sees exactly `HostEnv` (M2 mutation guards a leak).
- Logger is opt-in: with no `ExecLogger`, the library writes nothing anywhere.
- `StdioAcpClient` rejects requests on closed transports with `AcpTransportClosedError`; JSON-RPC error replies surface as `AcpResponseError` (with `.code`), which `initializeAcpSession` uses for the `-32000` auth retry.
- Warm-pool keys are credential-scoped; `poolKeyFor` fails closed (`HostInputError`) on a missing scope.

## Parity classification vs `packages/agentchat/test/adapters/`

| File                                           | Tests   | Disposition                                                                                                         |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `stdio-acp-client.test.ts`                     | 11      | Ported via `shim.ts` (host binds logger→console)                                                                    |
| `stdio-acp-client-onrequest.test.ts`           | 6       | Ported via `shim.ts`                                                                                                |
| `stdio-acp-server.test.ts`                     | 5       | Ported via `shim.ts` (aborted-signal pre-check + stderr tee are host choices)                                       |
| `stdio-acp-permission.test.ts` (bounds block)  | 4 of 20 | Ported verbatim (extracted `StdioAcpPermissionContext`)                                                             |
| `stdio-acp-permission.test.ts` (adapter block) | 16      | **Not portable** — drives `StdioAcpAdapter` (not extracted)                                                         |
| `cli-spawn.test.ts`                            | 24      | **Not portable** — `SpawnOpts`/`DispatchEvent`/thought-capture are Penumbra dispatch surface                        |
| `cli-spawn-stream.test.ts`                     | 14      | **Not portable** — vendor adapter classes (`ClaudeCliAdapter`, `CodexCliAdapter`, `GeminiCliAdapter`) not extracted |
| `acp-warm-pool.test.ts`                        | 22      | **Not portable** — key/refcount API superseded by spec-keyed ownership transfer                                     |

Ported: 26 tests (all passing). Not portable: 76 tests — each exclusion is
because the file exercises Penumbra-side orchestration the extraction
deliberately left behind, not because behavior regressed. The contract suite
(43 tests) covers the extracted semantics directly.
