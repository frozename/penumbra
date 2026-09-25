# Section 2 — surface delta: `packages/agentchat/src/adapters/*` → `penumbra-exec-primitives`

Generated 2026-09-25T15:19:43.331Z at commit 4864af39fb209797f530f4a22e1de03e865edcf0. Baseline for the
extraction boundary: what changed, and which original-behavior surfaces are
intentionally not preserved.

## Boundary imports removed

| Adapter source | Removed import | Replaced by |
| --- | --- | --- |
| `cli-spawn.ts` | `@penumbra/core` (DispatchEventInput), `@src/sdk/adapter.js` (DispatchEvent), `@src/worker/thought-capture.js` | File deleted; generic supervision extracted to `process-supervisor.ts` |
| `stdio-acp-permission.ts` | `@src/sdk/adapter.js` (DispatchInput) | `PermissionHost` — host passes `signal`, `dispatchId`, `decide`, `logger` |
| `stdio-acp-server.ts` | none (was already local) | `console.error` → `logger`; stderr tee → `onStderrChunk` callback |
| `stdio-acp-client.ts` | none | `console.*` → `ExecLogger`; close-guards added |
| `acp-warm-pool.ts` | `@src/adapters/stdio-acp-client.js` (type-level) | `AcpPoolClient` structural type (no runtime import) |

## Renamed / reshaped surfaces

| Before (agentchat) | After (exec-primitives) | Note |
| --- | --- | --- |
| `spawnCliAdapter(opts)` | `superviseProcess(opts)` | Dispatch events, thought capture, SDK types removed; `command` (was `binary`), `env`+`signal`+`cancelGraceMs`+`watchdogMs` are required host inputs |
| `spawnCliAdapterStream` | not extracted | Streaming dispatch is Penumbra orchestration, not an execution primitive |
| `startStdioAcpServer({binary,...})` | `startStdioAcpServer({command, env, signal, cancelGraceMs, stderrTailBytes, ...})` | env never defaults; stderr is never teed to process.stderr |
| `createAcpWarmPool` key/refcount | `acquire(spec)`/`deposit(spec, entry)`, `poolKeyFor(spec)` requiring `credentialScope` | ownership-transfer semantics; cross-credential reuse impossible by construction |
| `StdioAcpAdapter.dispatch` permission flow | `handleStdioAcpPermissionRequest(host, context, wireRequest)` | adapter class not extracted; wire handler + `StdioAcpPermissionContext` are |

## Parity classification vs `packages/agentchat/test/adapters/` (102 origin tests)

| Origin file | Tests | Disposition |
| --- | --- | --- |
| `cli-spawn.test.ts` | 24 | Ported verbatim over `src/shim/cli-spawn.ts` |
| `stdio-acp-client.test.ts` | 11 | Ported verbatim over `src/shim/stdio-acp-client.ts` |
| `stdio-acp-client-onrequest.test.ts` | 6 | Ported verbatim over the same shim |
| `stdio-acp-server.test.ts` | 5 | Ported verbatim over `src/shim/stdio-acp-server.ts` |
| `acp-warm-pool.test.ts` | 22 | Ported verbatim over `src/shim/acp-warm-pool.ts` (holder/refcount layer rebuilt over the packed pool) |
| `stdio-acp-permission.test.ts` | 20 | Re-expressed as 28 cases in `test/permission-and-stream.parity.ts` against `StdioAcpPermissionContext` + `handleStdioAcpPermissionRequest` (terminal-status rows parameterize the same assertions) |
| `cli-spawn-stream.test.ts` | 14 | Stream half re-expressed (10); vendor-adapter wiring (4) excluded — classes not extracted |

Ported 68 verbatim + 38 re-expressed = 106 parity tests executed against the
packed tarball. Excluded origin cases exercise the non-extracted
`StdioAcpAdapter` executor or vendor adapter classes; each exclusion is a
Penumbra-side orchestration surface the extraction deliberately left behind.

## Behavior changes that are deliberate

- No `@penumbra/*`, `@src/*`, `process.env`, `console.*`, or ambient
  filesystem/config access in `src/` — enforced by `scripts/closure-audit.ts`
  (src, consumers, packed tarball, plus a self-test fixture suite).
- Environment is verbatim: the child sees exactly `HostEnv` (mutation b guards
  the leak).
- Logger is opt-in: without an `ExecLogger` the library writes nothing.
- `StdioAcpClient` rejects requests on a closed transport with
  `AcpTransportClosedError`; JSON-RPC error replies surface as
  `AcpResponseError` (with `.code`), which `initializeAcpSession` uses for
  the `-32000` auth retry.
- Warm-pool keys are credential-scoped; `poolKeyFor` fails closed
  (`HostInputError`) on a missing scope.
