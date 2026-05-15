# Sequential-Thinking MCP Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `mcp-sequential-thinking` MCP server into penumbra's heavyweight planning agents (oc-deepseek-v4-pro, oc-kimi-k2.6, oc-glm-5.1, oc-mimo-v2.5-pro) to address the mid-stream truncation pattern observed today (3/3 reviewer dispatches failed silent or short).

**Why:** When asked to read multiple files and produce a structured review, heavyweight agents have repeatedly cut off after one or two file reads ("Now let me read the ACP SDK types file..." then nothing). The sequential-thinking MCP exposes a `think_step` tool that lets the agent externalize its reasoning as a sequence of tool calls — each step is a separate transaction with the model, so the cumulative output isn't bounded by a single completion's max_tokens. Empirically this pattern significantly reduces the truncation failure mode.

**Architecture:** Pure operator-side configuration — no penumbra code changes. The MCP server is a third-party package (`@modelcontextprotocol/server-sequential-thinking`) that runs as a stdio child of the agent. Wire it via the existing `options.mcpServers` plumbing that Phase 1a shipped. Maestro adds it to the relevant agents' yaml entries; agents pick it up on next dispatch.

**Tech Stack:** Operator yaml edits, daemon hot-reload, worker restart, MCP smoke test.

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Modify | `~/.config/agentchat/agentchat.yaml` (NOT git-tracked) | Add `sequential-thinking` MCP server to 4 heavyweight agents' `options.mcpServers` arrays. |

No code changes. The `mcpServers` plumbing already exists from Phase 1a.

---

## Task 1: Validate the MCP package runs standalone (MAESTRO-SIDE)

- [ ] **Step 1: Verify the package is reachable via npx**

```bash
timeout 5 npx -y @modelcontextprotocol/server-sequential-thinking < /dev/null 2>&1 | head -3
```

Expected: starts, prints a banner / log line on stderr, then exits when timeout hits OR when stdin closes. If the package is unreachable, the dispatch will fail immediately with a clear error, so this step de-risks before agent dispatch.

If `@modelcontextprotocol/server-sequential-thinking` is not the right package name, replacement candidates:
- `mcp-sequential-thinking` (community)
- `sequential-thinking-mcp` (community variant)

Pick the one that runs cleanly under `npx -y`.

---

## Task 2: Wire into 4 heavyweight agents (MAESTRO-SIDE)

Edit `~/.config/agentchat/agentchat.yaml` for each of:
- `oc-deepseek-v4-pro`
- `oc-kimi-k2.6`
- `oc-glm-5.1`
- `oc-mimo-v2.5-pro`

These are the agents in the trusted-heavyweight tier per the agent-performance ledger. They see the largest review/plan-refining workloads, where mid-stream truncation hurts most.

The opencode-* agents use `adapter: opencode-cli` (NOT stdio-acp), so the MCP wiring path is opencode-side. OpenCode reads `mcpServers` from yaml when it spawns its CLI subprocess. Each agent entry gets:

```yaml
  - name: oc-deepseek-v4-pro
    adapter: opencode-cli
    # ... existing fields ...
    options:
      # ... existing options ...
      mcpServers:
        - name: sequential-thinking
          command: npx
          args:
            - "-y"
            - "@modelcontextprotocol/server-sequential-thinking"
          env: []
```

Note: OpenCode CLI may use a different mcpServers key name (e.g., `mcp_servers` snake_case, or read from a separate config file). Verify by reading `packages/agentchat/src/adapters/opencode-cli.ts` for the actual option-forwarding behavior, OR by consulting opencode's own MCP config docs. **Do not blindly assume the stdio-acp `mcpServers` shape works for opencode-cli.**

If opencode-cli does NOT support per-dispatch mcpServers via yaml, the alternative is opencode's own global config at `~/.config/opencode/opencode.json` — but that's global, not per-agent, so we'd lose the ability to scope the MCP to just the 4 heavyweights. In that case, document the limitation and either: (a) accept global enablement, (b) skip this MCP for now, or (c) add an opencode-cli option to forward yaml mcpServers properly.

- [ ] **Step 1: Probe how opencode-cli passes MCP config**

```bash
grep -n 'mcpServers\|mcp_servers\|McpServers\|--mcp' packages/agentchat/src/adapters/opencode-cli.ts | head -10
```

If no matches, opencode-cli currently doesn't thread mcpServers — STOP and decide path (b) or (c) above.

- [ ] **Step 2: Edit yaml for all 4 agents**

For each agent name listed above, append the `mcpServers` block to its `options:`. Do NOT touch any other fields.

- [ ] **Step 3: Reload daemon**

```bash
PORT=$(cat /tmp/penumbra-live/port)
TOKEN=$(cat /tmp/penumbra-live/token)
curl -sS -X POST -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/agentchat/reload"
```

Expected: `{"ok":true,"agent_count":51,"reloaded_at":"..."}`

- [ ] **Step 4: Restart workers**

```bash
pkill -TERM -f 'agentchat-worker.ts' ; sleep 2
for w in primary b c d; do
  nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-$w > /tmp/worker-$w.log 2>&1 &
done
sleep 5
ps aux | grep agentchat-worker | grep -v grep | wc -l
```

Expected: `4`.

---

## Task 3: Re-run the failed reviewer dispatch as smoke (MAESTRO-SIDE)

The original failure: oc-deepseek-v4-pro asked to review the Phase 1b.1 plan against 9 verification points. Truncated mid-stream after 19s with only "Now let me read the ACP SDK types file." — never produced findings.

With sequential-thinking, the agent should be able to externalize each verification step as a tool call and produce a structured review.

- [ ] **Step 1: Dispatch the same review prompt**

Via `mcp__penumbra__chain_start({ initial_agent: 'oc-deepseek-v4-pro', message: <Phase 1b.1 review prompt>, ... })`.

- [ ] **Step 2: Wait for completion**

`chain_wait` with timeout 600000.

- [ ] **Step 3: Compare against the prior failure**

Before this MCP integration: 19s, truncated, 0 verification points covered.

After: target 60-180s, full review covering all 9 verification points, structured response.

If the response is still truncated, the MCP didn't help — log finding in ledger, defer to a follow-up.

- [ ] **Step 4: Append to agent-performance ledger**

One row per re-run, capturing: agent, latency, response quality (truncated/full), token cost, observation about whether sequential-thinking helped.

---

## Verification — does the plan cover the spec?

| Goal | Task |
|---|---|
| Sequential-thinking MCP installed and reachable | Task 1 |
| Wired to 4 heavyweight agents per-yaml | Task 2 |
| Reviewer reliability improvement validated by smoke | Task 3 |

## Risks & open questions

1. **opencode-cli may not forward yaml mcpServers** — would require either accepting global enablement (lose per-agent scoping) or adding a code-side fix. Probe in Task 2 Step 1.
2. **Sequential-thinking may not actually help oc-deepseek's truncation** — the truncation could be from other causes (provider rate limits, opencode permission rejections we saw with kimi). If smoke A doesn't improve, document and move on.
3. **Cost/latency tradeoff** — sequential-thinking adds tool-call round trips. Reviews go from one completion to N completions. Token cost may double; latency may triple. Acceptable if reliability goes from 0% → 100%; not acceptable if reviews go from 19s-truncated to 60s-truncated.

## Estimated effort

- Task 1 (validate package): 5 min
- Task 2 (yaml edits + reload + restart): 15 min
- Task 3 (smoke + ledger): 30 min

Total: ~50 min maestro-side. No implementer dispatch needed — this is operator config work.
