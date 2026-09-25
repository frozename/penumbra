# penumbra-exec-primitives

Shared execution primitives extracted from Penumbra's `agentchat` adapter layer:
process-group supervision (`superviseProcess`, `runProcess`), stdio ACP transport
(`StdioAcpClient`, `startStdioAcpServer`), permission request handling
(`StdioAcpPermissionContext`, `handleStdioAcpPermissionRequest`), a warm-process
pool (`createAcpWarmPool`, `poolKeyFor`, `acpSpecHash`), and ACP session bootstrap
(`initializeAcpSession`).

## Host contract

Every input that shapes execution is host-supplied and fail-closed:

- `env` reaches `spawn` verbatim. The library never merges, inherits, or reads
  the parent environment. A missing `env` throws `HostInputError` before spawn.
- `cwd` is required. The library never defaults to the parent working directory.
- `cancelGraceMs` is required on the supervisor, the conveniences, and
  `startStdioAcpServer`. `watchdogMs` is required on the supervisor and the
  conveniences. No library default exists for either.
- `clientInfo` for `initializeAcpSession` is host-supplied and placed on the
  wire verbatim. There is no built-in client identity.
- `poolKeyFor` requires a non-empty host `credentialScope` digest; entries under
  different scopes never share.
- Warm pooling is **not** session resume: the pool holds a live process plus an
  initialized transport. Each consumer issues its own `session/new`.
- No retry, fallback, takeover, or cross-process state exists in the library,
  except the single `session/new` retry after a successful `authenticate`.

Logging is optional and injected (`logger: { debug?, warn?, error? }`). Without
one, the library writes nothing to stdio or console.

## Status

The package name, home, and distribution channel are undecided; the name
`penumbra-exec-primitives` is a placeholder and the package is marked
`private: true` as a tripwire against accidental publish.
