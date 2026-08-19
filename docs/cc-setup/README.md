# Claude Code orchestration setup — reconstitution guide

This directory versions the **machine-local Claude Code orchestration layer** that makes
penumbra's fleet/workflow integration work. None of it ships in a vanilla penumbra clone by
default — it lives in `~/.claude/*` (machine-global) and `.claude/*` (project-local), so a
fresh machine or a fresh clone has to be reconstituted from here.

## The three scopes (what's portable and what isn't)

| Layer | Lives in | Scope | Survives a fresh… |
|---|---|---|---|
| **penumbra source behavior** (daemon/MCP/memory fixes) | penumbra git history | the codebase | clone ✅ |
| **Workflow scripts** | `.claude/workflows/*.js` | the penumbra project | clone ✅ *(once committed — that's what this branch does)* / other projects ❌ unless mirrored to `~/.claude/workflows/` |
| **Ultracode + anti-fabrication CLAUDE.md + GC guard hook** | `~/.claude/` | every project on the machine | machine ❌ — reconstitute from this dir |
| **Penumbra MCP connection** (`PENUMBRA_MCP_ORIGIN`, storage root) | `~/.claude.json` | this machine | machine ❌ — see below |

## Reconstitute a fresh machine

1. **Anti-fabrication protocol** → copy `CLAUDE.md` to `~/.claude/CLAUDE.md`. *(Contains personal
   operating instructions — review before sharing publicly; do not commit to a public mirror verbatim.)*
2. **GC guard hook** → copy `hooks/penumbra-agent-gc-guard.sh` to `~/.claude/hooks/` (`chmod +x`),
   and its regression test to `~/.claude/hooks/test/`. The hook protects fleet branches by `handoffs.branch_name` DB membership, with a legacy `agent/<uuid>` regex fallback when the DB or sqlite3 is unavailable. Run the test to confirm: `GUARD=docs/cc-setup/hooks/penumbra-agent-gc-guard.sh bash docs/cc-setup/hooks/test/penumbra-agent-gc-guard.test.sh`.
3. **Settings** → merge `settings.snippet.json` into `~/.claude/settings.json` (the `ultracode`
   flag + the PreToolUse(Bash) hook wiring). The full `settings.json` is intentionally NOT copied
   here — it holds credentials.
4. **Penumbra MCP** → in `~/.claude.json` under `mcpServers.penumbra.env`, set
   `PENUMBRA_STORAGE_ROOT`, `PENUMBRA_MCP_INVOCATION_LOG_ENABLED=1`, and `PENUMBRA_MCP_ORIGIN=maestro`.
5. **Daemon** → install + start `dev.penumbra.daemon` (runs `bun packages/cli/bin/penumbra.ts start`).

## Make the workflows global (every project, not just penumbra)

```sh
mkdir -p ~/.claude/workflows && cp <repo>/.claude/workflows/*.js ~/.claude/workflows/
```
Project-local `.claude/workflows/` only applies when CC runs inside that project; the global dir
applies everywhere. (The mirror was done when this branch was created.)

## Workflow model-tiering policy (cost/quality)

The fleet/orchestration `agent()` calls inherit the session model (Opus 4.8) unless given an
explicit `model:` override. The implementation work already runs on the penumbra fleet
(`codex-acp-deep`), so only the thin glue should ever be on Opus. Policy applied across the scripts:

| Role | Tier | Why |
|---|---|---|
| Pure broker / poll glue (fanout, tournament/swarm dispatch, review-sweep) | **haiku** | one chain_start + poll; structured schema enforces output |
| Dispatch-lifecycle glue (fleet-verify, token-opt dispatch/verify/land) | **sonnet** | runs the chain_start→poll→collect lifecycle inline where fabrication risk lives |
| Read-only probe / prime / persist / personas / web-research | **sonnet** | generation/measurement; diversity comes from the prompt, not the tier |
| Final synthesis / judge / red-team / planner-decomposition | **opus** | the quality-determining judgment — do NOT economize here |

Match tier to **risk**, not just cost: a rubber-stamp verifier or weak synthesizer costs more
than it saves.

## What is NOT here (and why)
- The full `~/.claude/settings.json` and `~/.claude.json` — they hold credentials/tokens.
- The 100+ `docs/notes/maestro-continuation-*` session logs — session detritus, not infrastructure.
