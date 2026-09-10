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
