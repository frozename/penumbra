# Tooling knowledge distribution — agentic discovery surface for the personal fleet

**Status:** design approved, awaiting implementation plan
**Date:** 2026-04-26
**Scope:** populate the per-repo agent-readable docs across 4 tools (penumbra, llamactl, sirius-gateway, embersynth), wire the existing MCP servers into Claude Code / Gemini CLI / Codex CLI configs, and centralize cross-agent reference docs inside penumbra (the orchestration owner).

## Problem

Every prompt that references llamactl, penumbra, sirius-gateway, or embersynth pays an overhead tax: AI coders spend tokens grepping the codebase and reading source files to learn what tooling exists. The four repos each have empty 5-line `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `JULES.md` stubs. Three of the four MCP servers built for these tools are not registered with any agentic harness, so their tool-level surface is invisible until manually called out. The cumulative effect is that AI agents working in this fleet behave as if the fleet doesn't exist.

## Goals

1. AIs working in any of the 4 repos answer "what does this tool do" and "how do I run its tests" from `AGENTS.md` — no source grep required.
2. Claude Code, Gemini CLI, and Codex CLI sessions started anywhere on this machine see penumbra-mcp / llamactl-mcp / sirius-mcp tools as first-class capabilities.
3. Penumbra (the cross-agent orchestrator) carries definitive cross-agent reference docs: bench calibration, dispatch idioms, key resolution. Anyone routing work to the fleet can answer "which agent for this task" from these docs.
4. The bench harness that drove the calibration becomes a maintained, runnable artifact (`bench.ts`) so future model evaluations don't require re-deriving the prompts.

## Non-goals

- A separate cross-repo "fleet plugin" with its own skills bundle. The cross-agent knowledge lives inside penumbra's repo.
- Cursor / JetBrains MCP wiring. Out of scope; revisit when those harnesses are in active use.
- Building an embersynth MCP server if it does not already exist. Recon during implementation will confirm; if absent, deferred to a follow-up spec.
- A unified config-source-of-truth that generates the 3 harness configs from one input. The 3 configs are hand-written, kept in sync by reviewer discipline.
- Multi-machine sync of the user-level configs. The `~/.claude` / `~/.gemini` / `~/.codex` files use absolute paths that bind to this machine's filesystem; portability is a separate dotfile concern.
- Tailored AI-tool-specific writing (separate Claude vs Gemini vs Jules content). The pointer-file pattern below uses `AGENTS.md` as the canonical source and the per-tool files as 5-line redirects.

## Architecture

```
penumbra/                                   ← canonical repo for cross-agent docs
  AGENTS.md                                 ← canonical, ~150 lines, full structural doc
  CLAUDE.md, GEMINI.md, JULES.md            ← thin pointers (~5 lines each)
  packages/agentchat/
    docs/
      agent-fleet.md                        ← bench calibration table + routing guide
      dispatch-examples.md                  ← --auto / --attach / --max-hops walks
      openai-compat-keys.md                 ← apiKey / apiKeyEnv / apiKeyKeychain / apiKeyFile
    scripts/
      bench.ts                              ← runnable port of /tmp/penumbra-dispatch/bench2.sh

llamactl/, sirius-gateway/, embersynth/     ← per-repo
  AGENTS.md                                 ← canonical
  CLAUDE.md, GEMINI.md, JULES.md            ← thin pointers

User-level MCP wiring (3 harnesses, identical server set):
  ~/.claude/settings.json                   ← mcpServers JSON map
  ~/.gemini/settings.json                   ← mcpServers JSON map
  ~/.codex/config.toml                      ← [mcp_servers.<name>] TOML sections

MCP servers registered:
  - penumbra-mcp        (packages/mcp/bin/penumbra-mcp.ts — already exists)
  - llamactl-mcp        (packages/mcp/ — bin entry to confirm during recon)
  - sirius-mcp          (apps/sirius-mcp — bin entry to confirm during recon)
  - embersynth-mcp      (recon: register if exists; defer if absent)
```

The 3 harness configs are user-level (not project-level `.mcp.json`) so the fleet's MCP tools are available in any session anywhere on the machine, not only when working inside one of the repos.

## Components

### Per-repo `AGENTS.md` (canonical content shape)

Same backbone across all 4 repos so AIs find consistent landmarks:

```markdown
# <tool name>

<one-paragraph elevator pitch>

## Architecture
<top-level packages/dirs and their roles, ~10 lines>

## Quick reference
<build / test / run commands, common dev tasks>

## Conventions
- Commit style: conventional commits, no AI / agent attribution in messages
- TDD discipline where applicable
- Anything non-obvious (e.g., "Bun ONNX teardown panic at end of test runs is cosmetic")

## MCP surface
<what tools this repo exposes via MCP; how to invoke; pointer to bin/server entry>

## Related fleet tools
<focus on which integrations this repo participates in: penumbra ↔ llamactl ↔ sirius ↔ embersynth>

## Where to dig deeper
<file pointers — README.md, docs/superpowers/specs/, packages/<x>/README.md>
```

**Length targets:**
- penumbra: ~150 lines (largest surface — agentchat, MCP, daemon, worker, t0/t1)
- llamactl: ~120 lines (catalog, agent serve, kubeconfig, infra, providers)
- sirius-gateway: ~120 lines (apps + libs, multi-provider, observability)
- embersynth: ~60-80 lines (smaller surface, pending recon)

### Per-repo pointer files (`CLAUDE.md`, `GEMINI.md`, `JULES.md`)

Uniform template (~5 lines):

```markdown
# <tool name> — <AI tool> notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP, fleet integration).

<optional: 2-3 line tool-specific addendum if anything genuinely differs for this AI tool>
```

For 90% of cases, the addendum is empty. Skill triggers / tool-specific formatting hints are the only legitimate reasons to deviate; otherwise the pointer files are pure redirects.

### Penumbra cross-agent docs (`packages/agentchat/docs/`)

**`agent-fleet.md`** (~80 lines) — operating reference for the calibrated agent fleet.
- Bench-2 results table (gemma 4 family, qwen 3.x family, qwen3-coder-480B, NVIDIA hosted models — every model we measured).
- Sweet-spot pairings: task profile → recommended agent (e.g. quick extraction → mac-mini gemma 4 E4B; code review → local gemma 4 26B-A4B; frontier coder → nv-qwen3-coder-480b).
- AVOID list with reasons (qwen 3.6 35B-A3B at any quant, deepseek-v4 family on NVIDIA free tier).
- Architecture-pattern observations (Qwen 3.x A3B 3B-active reasoning blind spot, gemma family dominance, dense-vs-MoE).
- Pointer to `bench.ts` for revalidating against new candidate models.

**`dispatch-examples.md`** (~100 lines) — concrete recipe book for `agentchat new`.
- `--auto` headless chain (one-shot via `@mention`).
- `--attach <file>` example: dispatching code review with inlined source.
- `--auto --max-hops N --transcript-budget B` for chained dispatches.
- `--trust` per-edge approval pattern with `auto_approve_to`.
- Bin streaming vs worker dispatch (when to use which).
- MCP `chain.start` for headless triggers (cron, webhooks, no TTY).
- Common pitfalls: `parseInputStream` whole-mode behavior on piped input, attachment header convention.

**`openai-compat-keys.md`** (~50 lines) — secret-ref reference for the openai-compat-http adapter.
- The 4 secret-ref shapes: `apiKey` (literal) / `apiKeyEnv` / `apiKeyKeychain` / `apiKeyFile`.
- macOS `security add-generic-password -s llamactl -a <service>` cookbook.
- Resolution precedence (literal > env > keychain > file > anonymous).
- Anonymous-endpoint pattern (`apiKey: local-no-auth`) for dev llama-server.
- Existing entries in `agentchat.yaml` as concrete examples (mac-mini gemma planner, NVIDIA NIM cloud agents).

**`scripts/bench.ts`** (~150 lines) — TypeScript port of `/tmp/penumbra-dispatch/bench2.sh`.
- CLI: `bun packages/agentchat/scripts/bench.ts --label NAME --url URL [--model M] [--auth-token T] [--auth-cert PATH]`.
- Direct fetch to the OpenAI-compat endpoint (no agentchat involvement, no penumbra daemon dependency).
- Reads the same fixture files (`packages/agentchat/src/worker/dispatcher.ts`, `packages/agentchat/src/cli/attachments.ts`, `packages/agentchat/README.md`) from the repo as the prompt context.
- Emits one structured JSON line per task (so future runs can be diffed/aggregated).
- Same 5 bench-2 tasks; same prompts (extracted to a constants file in the same dir so they don't drift).
- Each doc above references `bench.ts` for "how to verify against your own model."

The shell script (`bench2.sh`) lives on as the original prototype but is not maintained. `bench.ts` is canonical.

### MCP server wiring (3 harness configs, identical server set)

Each MCP server gets the **same definition** (command + args + env) across the three configs. The reviewer discipline is "if you change one, change all three" — captured in the implementation plan as a checklist step.

**`~/.claude/settings.json`**:
```json
{
  "mcpServers": {
    "penumbra": {
      "type": "stdio",
      "command": "bun",
      "args": ["/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts"],
      "env": { "PENUMBRA_STORAGE_ROOT": "/tmp/penumbra-live" }
    },
    "llamactl": { "type": "stdio", "command": "<bin>", "args": [...] },  // ← filled in during recon
    "sirius":   { "type": "stdio", "command": "<bin>", "args": [...] }   // ← filled in during recon
  }
}
```

**`~/.gemini/settings.json`** — same JSON `mcpServers` shape.

**`~/.codex/config.toml`** (TOML sections):
```toml
[mcp_servers.penumbra]
command = "bun"
args = ["/Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/bin/penumbra-mcp.ts"]

[mcp_servers.penumbra.env]
PENUMBRA_STORAGE_ROOT = "/tmp/penumbra-live"
```

**Recon to do during implementation (not before):**
1. Confirm llamactl-mcp's bin entrypoint (probably `packages/mcp/bin/<name>.ts`).
2. Confirm sirius-mcp's bin entrypoint (probably `apps/sirius-mcp/...`).
3. Embersynth: search for an MCP server in the repo. Register if present; omit + open follow-up issue if absent.
4. Daemon prerequisites: penumbra-mcp requires `/tmp/penumbra-live` to exist (`penumbra start --detach`). Document any analogous prereqs for llamactl-mcp / sirius-mcp.

## Data flow

There is no runtime data flow proper — this is a knowledge-distribution spec. The "flow" is at the human/agent reading layer:

1. **Cold session, in-repo:** AI tool reads its own format file (`CLAUDE.md` / `GEMINI.md` / etc.) → redirected to `AGENTS.md` → finds full content. Cross-tool relationships are listed under "Related fleet tools" with file pointers to deeper docs.
2. **Cold session, anywhere:** AI tool's user-level config lists the fleet's MCP servers → tool listings include penumbra-mcp, llamactl-mcp, sirius-mcp → AI can call `memory.recall`, `chain.start`, llamactl operator surfaces, sirius gateway surfaces directly without reading source.
3. **Cross-agent dispatch decisions:** any AI working anywhere can read `penumbra/packages/agentchat/docs/agent-fleet.md` to pick the right agent for a task — calibration table is one click away from the bench harness that produced it.

## Error handling and edge cases

- **MCP server unreachable.** If the backing daemon isn't running (e.g. penumbra-mcp without `/tmp/penumbra-live`), the harness fails to register that MCP. The fleet docs note this as a startup prerequisite. Sessions degrade to "MCP missing" but text-level docs are unaffected.
- **AGENTS.md drift.** When the source code changes substantively, `AGENTS.md` may go stale. Mitigation: a CI hint or pre-commit-hook idea is OUT of scope for this spec; we accept that the doc is maintained by reviewer discipline. The "Where to dig deeper" pointers reduce the cost of a stale doc by linking to canonical sources.
- **Pointer-file drift.** The `CLAUDE.md` / `GEMINI.md` / `JULES.md` files are 5-line redirects; they should rarely drift. If a tool-specific addendum is added, its expiration condition is documented inline so future readers know when to remove it.
- **Embersynth without MCP.** If recon confirms embersynth has no MCP server, this spec ships AGENTS.md and pointer files only for that repo; MCP wiring for it is opened as a follow-up issue.
- **Fleet draft quality.** Phase 2 dispatches per-repo AGENTS.md drafts to specific agents; if the draft fails Section 2's structural check or the gate-review, I rewrite the section by hand rather than re-dispatching. The fleet flex is a productivity assist, not a load-bearing dependency.

## Build method (3 phases)

**Phase 1 — I author with session context (single-pass):**
- penumbra `AGENTS.md` (template + concrete content covering agentchat, MCP, daemon, worker, t0/t1).
- penumbra `packages/agentchat/docs/{agent-fleet,dispatch-examples,openai-compat-keys}.md`.
- penumbra `packages/agentchat/scripts/bench.ts` + a unit test that runs it against a stub HTTP server returning canned model responses.
- All 4 repos' `CLAUDE.md` / `GEMINI.md` / `JULES.md` pointer files (12 files total, uniform template).
- Three harness configs: `~/.claude/settings.json`, `~/.gemini/settings.json`, `~/.codex/config.toml`.

**Phase 2 — Fleet drafts, I review/edit/commit:**
- `llamactl/AGENTS.md` ← `@local-gemma26` with `--attach` of llamactl's README + key src files (catalog, server, agent serve).
- `sirius-gateway/AGENTS.md` ← `@nv-qwen3-coder-480b` with `--attach` of sirius's README + apps/ layout + libs/ overview (large repo, frontier coder context handles it).
- `embersynth/AGENTS.md` ← `@nv-llama4-maverick` with `--attach` of embersynth's README + bin + src tree.
- I gate-check each draft against Section 2's template, edit as needed, commit per-repo. No direct fleet commits.

**Phase 3 — Manual verification:**
- Fresh Claude Code session in each of the 4 repos: ask "what does this tool do? how do I run its tests?" → expect AGENTS.md content surfaces.
- `claude /mcp` (or equivalent) in a fresh session at any path → confirm penumbra/llamactl/sirius MCP tools register.
- Same in fresh `gemini` and `codex` sessions.
- Run `bun packages/agentchat/scripts/bench.ts --label gemma4-26b --url http://127.0.0.1:8080/v1` against the running local llama-server and compare output to existing `/tmp/penumbra-dispatch/bench2-gemma26moe.txt` — semantically equivalent answers expected.

## Testing

- **Unit:** `bench.ts` against a stub HTTP server (one test verifies the structured JSON shape across all 5 tasks; one test verifies the `--model` / `--label` flag handling).
- **Manual smoke:** the 4 verification steps above; document outcome in PR/session notes.
- **No new daemon tests, no integration tests beyond the bench stub.** This is primarily a documentation + config spec; the only new code is `bench.ts` and its small test surface.

## Acceptance criteria

| # | Test |
|---|---|
| 1 | All 4 repos have populated `AGENTS.md` structurally matching the Section 2 template (every section header present, no placeholder content). Length is informational not gating — penumbra ~150, llamactl/sirius ~120, embersynth ~60-80. |
| 2 | All 4 repos have `CLAUDE.md`, `GEMINI.md`, `JULES.md` pointer files using the uniform 5-line template. |
| 3 | `~/.claude/settings.json`, `~/.gemini/settings.json`, `~/.codex/config.toml` each list penumbra-mcp + llamactl-mcp + sirius-mcp under their respective `mcpServers` (or TOML) section. Embersynth-mcp included if it exists; deferred otherwise. |
| 4 | penumbra has `packages/agentchat/docs/{agent-fleet,dispatch-examples,openai-compat-keys}.md` and `packages/agentchat/scripts/bench.ts`. |
| 5 | `bench.ts` produces structured JSON for the 5 bench-2 tasks against a model URL. One unit test covers the harness shape against a stub. |
| 6 | Fresh Claude Code session in `/tmp` (no project context) lists penumbra/llamactl/sirius MCP tools after start. |
| 7 | Fresh Gemini CLI + Codex CLI sessions list the same MCP tools. |
| 8 | Spot-check Q&A: "How do I dispatch a chain to gemma 4 via NVIDIA NIM with a file attached?" → answerable from docs alone, no source grep. |

## Open questions / explicitly deferred

- **Embersynth-mcp** — if recon confirms it doesn't exist, build out is deferred to a follow-up spec.
- **Cursor / JetBrains MCP wiring** — out of scope; add when those harnesses are in active use.
- **Multi-machine config sync** — these user-level configs hardcode absolute paths. Portability via a dotfile manager is a separate concern.
- **Unified config source-of-truth** — a generator that emits the 3 harness configs from one YAML input would prevent drift but adds an indirection. Out of scope; reconsider after seeing how often the configs drift in practice.
- **AGENTS.md staleness CI** — a hook/check that flags AGENTS.md when key source files change. Considered, deferred. Reviewer discipline is enough for a 4-repo fleet.
