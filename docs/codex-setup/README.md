# Codex hook capability contract

The fixture at `packages/cli/test/fixtures/codex-hooks/contract-cases.json` records the acceptance contract for the upcoming isolated Codex hook probe. It is test data, not a statement that any installed build has been proven to support these hooks.

| Aspect | CLI | Desktop |
| --- | --- | --- |
| Contract evidence | The release reference defines hook inputs and event-specific outputs. | The release reference defines hook inputs and event-specific outputs. |
| Live evidence | An isolated successful probe for the exact CLI build and capability. | An isolated successful probe for the exact desktop build and capability. |
| Minimum version | Not proven. | Not proven. |

Both `supported` and `unavailable` require matching-surface live evidence, a nonblank build, and a nonblank probe ID. Contract evidence alone may describe a capability but cannot establish either state. An unobserved capability remains `unknown`. Probe and identity metadata stay outside raw hook input so fixture host payloads contain only documented hook fields.

The reference was fetched on 2026-09-10 from [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks). The fixture contract requires `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and `model` for every supported fixture event; `transcript_path: null` is valid. It requires documented `permission_mode` values only on supported event branches that receive that field, and rejects it for `PreCompact` and `SessionEnd`. `SessionStart.source` is restricted to `startup`, `resume`, `clear`, or `compact`. The contract rejects other raw fields and binds `input.hook_event_name` to the fixture capability. Subagent hook `session_id` and identity `sessionId` describe the parent hook context; `agent_id` is the distinct child identity, not an independent child session. Post-tool fixtures retain representative sanitized `tool_response` values. Treat hook configuration as executable code: review and trust its exact definition before it runs.

The forthcoming isolated probe will establish live evidence independently for CLI and desktop. Until then, do not infer a supported minimum version from feature flags, generated schemas, or these contract fixtures.

## Isolated capability probe

Run the probe only with a caller-created, canonical, empty disposable root. It
rejects a symlinked root or ancestor and records each root/ancestor and
created-directory identity before any subprocess await. If a pathname is
replaced, it stops, leaves ambiguous paths untouched, and reports
`cleanupComplete: false`. The report output must be a new non-symlink file
below the unchanged supplied root.

\`\`\`sh
probe_root="$(mktemp -d /private/tmp/codex-probe.XXXXXX)"
bun scripts/probe-codex-capabilities.ts \
  --root "$probe_root" \
  --surface cli \
  --binary "$(command -v codex)" \
  --output report.json
\`\`\`

The runner writes only `CODEX_HOME/hooks.json` and a bounded, isolated command
handler under its disposable root. A successful capture exits with empty output,
so it cannot introduce an event-specific hook response. It claims one of 24
exclusive capture slots before waiting for each JSON input of at most 32 KiB.
The handler validates the capture directory identity before and after reserving
the no-follow descriptor, writes only through that descriptor after waiting, and
closes it on every completion path. The reader opens
only regular non-symlink files without following links and reads at most 32 KiB
plus one byte before parsing. It validates every resulting fixture with the
capability parser and only marks the exact observed event scenario as supported.
Startup does not qualify resume or compact; prompt, Bash, apply_patch, MCP,
deferred completion, compaction, stop, session end, and child lineage each
remain independent.

`UserPromptSubmit` remains `unknown` with
`user_prompt_input_contract_not_validated` because the fixture consumer does not
yet validate its input shape. Deferred Bash `PostToolUse` remains `unknown` with
`deferred_completion_correlation_not_validated` because the probe does not yet
correlate the completion to the initiating tool use. A raw observation alone
cannot qualify either scenario; their future qualification requires an explicit
consumer-contract and correlation follow-up.

The runner first verifies `codex mcp --help` exposes `add`, `list`, `get`, and
`remove`, then requires the isolated list/get artifact shape before reporting
MCP configuration support. `codex plugin --help` establishes only the separate
`plugin_command_surface` result; marketplace installation and discovery remain
unknown unless directly observed.

The probe supplies no credential, launch, or trust-bypass environment and
never uses \`--dangerously-bypass-hook-trust\`. Non-managed hooks require
normal `/hooks` review; when that review cannot be completed unattended, the
honest result is `unknown` with `trust_review_required` or the bounded command
reason. The sanitized 2026-09-10 CLI report records `codex-cli 0.153.4`, MCP
configuration and plugin command syntax only; no hook, plugin-installation, or
desktop capability is inferred. Desktop status requires isolated manual
interaction and cannot inherit CLI results.

## Ownership-safe setup

The Codex setup module supports explicit `standalone` and `plugin` modes. In
standalone mode it installs the complete validated skill inventory from the
dedicated Codex package and configures the `penumbra` stdio MCP server with the
current Bun executable, the absolute MCP entrypoint, and
`PENUMBRA_STORAGE_ROOT`. In plugin mode it uses only an injected host adapter
whose plugin-management capability and argv arrays were independently proven;
unknown or unavailable plugin support does not fall back to standalone skills.

Penumbra records only its own files, hashes, destinations, MCP block, and plugin
identifier in `<codexDir>/penumbra/installation.json`. Status compares that
record with every installed component. Install and repair stop before writes on
predictable ownership conflicts, while uninstall removes only unchanged owned
content and preserves user edits and unrelated Codex configuration.

Plugin installation is confirmed only when the adapter explicitly returns both
`ok: true` and `installed: true`. Repair reinstalls a previously owned plugin
only after a successful status check explicitly reports `installed: false`, then
requires the same explicit confirmation from the install call. Missing or failed
status results remain unknown and do not trigger speculative installation or
local ownership changes. Re-running repair for an installed plugin is idempotent.

An `installed` result means the files and configuration are present on disk. A
running Codex host may still need to reload its profile before it observes the
change. Task 2.2 does not install lifecycle hooks or telemetry; hooks remain
`absent` until phase 3, and daemon connection files produce only a separate
telemetry `absent` or `unknown` status rather than an invented endpoint.
