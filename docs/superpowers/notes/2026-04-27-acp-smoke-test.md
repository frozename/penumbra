# ACP smoke test — 2026-04-27

Status: fail

Scope:
- Wired `opencode-acp` into the built-in adapter registry.
- Reused the existing `oc-acp-deepseek-v4-pro` entry in `~/.config/agentchat/agentchat.yaml` and normalized its description and roles.
- Reloaded the daemon registry successfully via `daemon.reload_config`.

Smoke test:
- `conversation_id`: `conv-0c807c9f-64d7-47fe-b252-86d252224089`
- `handoff_id`: `65aba2ba-e555-4ee3-9c09-3406893c4156`
- Prompt: `Reply with exactly the word: pong`
- Result: no final agent response

Observed failure:
- Handoff status terminated as `failed`.
- Resolution reason: `unknown adapter kind: opencode-acp`

Boot-time observation:
- No ACP boot occurred during the smoke test. The failure happened before `opencode-acp.ts` dispatch or `acp-server.ts` startup, so there is no server boot timing or subprocess-level evidence to report.
- Post-smoke test probing: `opencode acp` exits with code 0 without reporting a port if `stdio` ignores stdin. Furthermore, when passing `--port 0`, the assigned port is never printed to stdout/stderr, even when enabling `--print-logs`.

Bugs surfaced:
- No runtime bug surfaced inside `opencode-acp.ts` or `acp-server.ts` during the smoke test itself.
- Operationally, daemon config reload was sufficient for `chain.start` validation but not sufficient for the already-running worker to recognize the newly registered built-in adapter kind in this run.
- **Boot Bug Fixed:** Replaced log-scraping port detection in `acp-server.ts` with explicit port assignment (`net.createServer` to find an available port) and TCP polling (`net.connect`). Also changed `stdio` to `['pipe', 'pipe', 'pipe']` to prevent immediate clean exits caused by an ignored stdin.
