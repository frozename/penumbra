# Discord MCP — Out-of-Band Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Discord webhook notifications into penumbra so the maestro is alerted out-of-band when:
- A dispatched handoff completes (success or failure) — useful for long-running work
- Phase 1c v2 ships and a permission-elicitation handoff requires operator approval (TTL-bound)
- A reconciler hits an unexpected failure mode worth attention
- A daily summary of dispatch activity (optional)

**Why:** Today the maestro polls handoffs via `chain_wait` (which blocks the conversation) or `handoff_get` (which I have to remember to check). Out-of-band push notifications free the maestro from polling and let dispatches run on different timescales than a single conversation. This is foundational for Phase 1c v2's human-pause flow — without out-of-band notification, the user has no signal that an agent is waiting.

**Architecture:** Use Discord's webhook API (one-way: penumbra → Discord channel) for v1. Webhooks are far simpler than a full bot — no OAuth, no presence, no message intent. A POST to a configured webhook URL surfaces a message in the operator's Discord. For v2 (deferred), a full bot with reply routing would let the operator respond in Discord and have penumbra act on it (approve/reject permission requests).

The integration is daemon-side, not adapter-side: the reconciler (or a new "notifier" hook in the dispatcher) posts to Discord on configured events. Agents themselves can also use a `discord-mcp` to post (e.g., a daily summary agent), but that's a v2 enhancement.

**Tech Stack:** TypeScript, Node fetch, daemon-side hook, Discord webhook URL, optional discord-mcp (community package) for agent-side posting.

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Create | `packages/agentchat/src/worker/discord-notifier.ts` | Pure function `postToDiscord(webhookUrl, message)` with retry + structured payload (embeds for handoff_id linking). |
| Modify | `packages/agentchat/bin/agentchat-worker.ts` | Read `PENUMBRA_DISCORD_WEBHOOK_URL` env var; call notifier on configured events (chain-end, reconciler outcome, dispatch failure). |
| Modify | `packages/agentchat/src/worker/merge-reconciler.ts` | Optional hook: notify on `pr_opened`, `pr_creation_failed`, `test_failed`, `typecheck_failed`. |
| Create | `packages/agentchat/test/worker/discord-notifier.test.ts` | Unit tests for payload shape, retry behavior, no-op when env var unset. |
| Create | `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md` | Operator setup recipe — webhook URL creation, env var, message template options. |

For v2 (agent-side discord-mcp), no code changes — just yaml additions following the Phase 1a `mcpServers` pattern. Out of scope for this plan.

---

## Pre-flight design decisions

1. **Notification trigger granularity** — what events fire a Discord post?
   - **Always**: dispatch completion (success/failure), reconciler PR-opened, reconciler PR-creation-failed.
   - **Configurable**: per-handoff opt-in via `chain.start({ notify: true })`? Or always-on with a "quiet hours" setting?
   - **Recommendation v1**: always-on for terminal events (dispatch done, reconciler done). Add `PENUMBRA_DISCORD_QUIET=1` env to silence if needed.

2. **Message format** — plain text or rich embed?
   - **Recommendation**: rich embed with color-coded status (green=success, yellow=warn, red=failure) and a few fields (agent, handoff_id, conversation_id, latency, link to penumbra dashboard or PR).

3. **Webhook auth** — single shared webhook URL (env var) or per-event channel routing?
   - **Recommendation v1**: single webhook URL. v2 could split by event type into multiple channels.

4. **Failure handling** — what if Discord is unreachable?
   - **Recommendation**: fire-and-forget with single retry (1s backoff). Don't block the worker. Log failure but don't surface to handoff state.

5. **Throttling** — could the daemon spam the channel during burst dispatches?
   - **Recommendation v1**: no throttling. If burst becomes a problem, add per-channel rate limit or coalesce-burst-into-summary later.

6. **Privacy** — should prompts be included in Discord posts?
   - **Recommendation**: NO prompt text by default (prompts can carry sensitive data). Include only metadata + link to handoff details. Add `PENUMBRA_DISCORD_INCLUDE_PROMPT=1` opt-in if needed.

---

## Task 1: Operator setup recipe (MAESTRO-SIDE, before any code)

**Files:**
- Create: `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md`

Documents:
1. How to create a Discord webhook (right-click channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL).
2. Env var to set: `PENUMBRA_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...`.
3. Optional: `PENUMBRA_DISCORD_QUIET=1` to disable, `PENUMBRA_DISCORD_INCLUDE_PROMPT=1` to include prompts.
4. Test command: `curl -X POST -H "Content-Type: application/json" -d '{"content":"penumbra test"}' "$PENUMBRA_DISCORD_WEBHOOK_URL"`.

This is operator-side; do it BEFORE the code work because the smoke depends on it.

---

## Task 2: `discord-notifier.ts` — pure helper

**Files:**
- Create: `packages/agentchat/src/worker/discord-notifier.ts`
- Create: `packages/agentchat/test/worker/discord-notifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/worker/discord-notifier.test.ts`:

```ts
import { describe, it, expect, mock } from 'bun:test';
import { postToDiscord, formatHandoffEmbed } from '../../src/worker/discord-notifier.js';

describe('postToDiscord', () => {
  it('no-ops when webhookUrl is undefined', async () => {
    const fetchMock = mock(async () => new Response('', { status: 200 }));
    await postToDiscord(undefined, 'msg', fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a content payload to the webhook URL', async () => {
    const fetchMock = mock(async () => new Response('', { status: 204 }));
    await postToDiscord('https://discord.com/api/webhooks/abc', 'hello', fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/webhooks/abc');
    expect((init as any)?.method).toBe('POST');
    const body = JSON.parse((init as any).body);
    expect(body.content).toBe('hello');
  });

  it('retries once on 5xx', async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      if (calls === 1) return new Response('', { status: 503 });
      return new Response('', { status: 204 });
    });
    await postToDiscord('https://discord.com/api/webhooks/abc', 'hello', fetchMock);
    expect(calls).toBe(2);
  });

  it('does not throw on permanent failure (fire-and-forget)', async () => {
    const fetchMock = mock(async () => new Response('', { status: 500 }));
    await expect(
      postToDiscord('https://discord.com/api/webhooks/abc', 'hello', fetchMock),
    ).resolves.toBeUndefined();
  });
});

describe('formatHandoffEmbed', () => {
  it('produces a green-color embed for completed handoffs', () => {
    const embed = formatHandoffEmbed({
      handoff_id: 'h-1', agent: 'codex-mini', status: 'completed',
      latency_seconds: 8, conversation_id: 'c-1',
    });
    expect(embed.color).toBe(0x00cc66);  // green
    expect(embed.fields).toContainEqual(expect.objectContaining({ name: 'agent', value: 'codex-mini' }));
    expect(embed.fields).toContainEqual(expect.objectContaining({ name: 'latency', value: '8s' }));
  });

  it('produces a red-color embed for failed handoffs', () => {
    const embed = formatHandoffEmbed({
      handoff_id: 'h-2', agent: 'gemini-flash', status: 'failed',
      latency_seconds: 540, conversation_id: 'c-2',
      error_summary: 'gemini quota exhausted',
    });
    expect(embed.color).toBe(0xcc0000);
    expect(embed.fields).toContainEqual(expect.objectContaining({ name: 'error', value: 'gemini quota exhausted' }));
  });

  it('omits prompt by default for privacy', () => {
    const embed = formatHandoffEmbed({
      handoff_id: 'h-3', agent: 'a', status: 'completed',
      latency_seconds: 1, conversation_id: 'c-3',
      prompt: 'sensitive content',
    });
    expect(JSON.stringify(embed)).not.toContain('sensitive content');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

`bun test packages/agentchat/test/worker/discord-notifier.test.ts` → FAIL (functions not exported).

- [ ] **Step 3: Implement the helper**

```ts
// packages/agentchat/src/worker/discord-notifier.ts

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
}

export interface HandoffNotificationContext {
  handoff_id: string;
  agent: string;
  status: 'completed' | 'failed' | 'rejected' | 'expired';
  latency_seconds: number;
  conversation_id: string;
  error_summary?: string;
  prompt?: string;       // ignored by formatter unless includePrompt = true
  pr_url?: string;
}

const COLOR_GREEN = 0x00cc66;
const COLOR_RED = 0xcc0000;
const COLOR_YELLOW = 0xcc9900;

export function formatHandoffEmbed(
  ctx: HandoffNotificationContext,
  opts: { includePrompt?: boolean } = {},
): DiscordEmbed {
  const color =
    ctx.status === 'completed' ? COLOR_GREEN :
    ctx.status === 'failed' || ctx.status === 'rejected' ? COLOR_RED :
    COLOR_YELLOW;
  const fields: DiscordEmbed['fields'] = [
    { name: 'agent', value: ctx.agent, inline: true },
    { name: 'status', value: ctx.status, inline: true },
    { name: 'latency', value: `${ctx.latency_seconds}s`, inline: true },
    { name: 'handoff', value: ctx.handoff_id, inline: false },
  ];
  if (ctx.error_summary) fields.push({ name: 'error', value: ctx.error_summary.slice(0, 1024) });
  if (ctx.pr_url) fields.push({ name: 'PR', value: ctx.pr_url });
  if (opts.includePrompt && ctx.prompt) {
    fields.push({ name: 'prompt', value: ctx.prompt.slice(0, 1024) });
  }
  return {
    title: `penumbra dispatch ${ctx.status}`,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };
}

export async function postToDiscord(
  webhookUrl: string | undefined,
  contentOrEmbed: string | { embeds: DiscordEmbed[] },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!webhookUrl) return;  // disabled / unconfigured

  const payload =
    typeof contentOrEmbed === 'string'
      ? { content: contentOrEmbed }
      : { embeds: contentOrEmbed.embeds };

  const post = async () => {
    return fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  };

  try {
    let res = await post();
    if (res.status >= 500 && res.status < 600) {
      // retry once on transient server error
      await new Promise((r) => setTimeout(r, 1000));
      res = await post();
    }
    // any non-2xx: log and move on (fire-and-forget)
  } catch {
    // network error or other: swallow
  }
}
```

- [ ] **Step 4: Tests pass + commit.**

---

## Task 3: Wire into the worker's chain-end + reconciler hooks

**Files:**
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Modify: `packages/agentchat/src/worker/merge-reconciler.ts`

In agentchat-worker.ts, read the env vars at startup:

```ts
const discordWebhookUrl = process.env.PENUMBRA_DISCORD_WEBHOOK_URL;
const discordQuiet = process.env.PENUMBRA_DISCORD_QUIET === '1';
const discordIncludePrompt = process.env.PENUMBRA_DISCORD_INCLUDE_PROMPT === '1';
```

In the dispatcher's `onChainEnd` handler, fire a notification:

```ts
onChainEnd: (handoff_id, reason) => {
  if (!handoff_id) return;
  if (reason === 'completed') {
    void reconcileWorktree(handoff_id).catch(...);
  }
  if (!discordQuiet) {
    void notifyChainEnd(handoff_id, reason);
  }
},
```

Where `notifyChainEnd` queries the daemon for the handoff details (agent, latency, error_summary if failed) and calls `postToDiscord(discordWebhookUrl, { embeds: [formatHandoffEmbed(ctx)] })`.

In the reconciler, on `pr_opened` or `pr_creation_failed` (per the github-mcp plan): post a separate Discord notification with the PR link.

- [ ] Steps to implement, test, commit.

---

## Task 4: Smoke (MAESTRO-SIDE)

1. Set `PENUMBRA_DISCORD_WEBHOOK_URL` in shell env.
2. Restart workers to pick it up.
3. Dispatch any small handoff (e.g., `chain_start({initial_agent: 'gemini-pro-direct', message: 'reply with PONG'})`).
4. Verify Discord channel receives a green embed with the dispatch's metadata.
5. Force a failure (e.g., dispatch to `codex-mini` with auth broken) and verify a red embed appears.

---

## Verification — does the plan cover the spec?

| Goal | Task |
|---|---|
| Discord notifier helper, tested in isolation | Task 2 |
| Worker reads env var and fires on chain-end | Task 3 |
| Reconciler fires on PR-opened / PR-failed (depends on github-mcp plan) | Task 3 |
| Operator setup recipe | Task 1 |
| Smoke validates end-to-end | Task 4 |

## Risks & open questions

1. **Discord webhook rate limits** — 30 messages per channel per 60 seconds. Burst dispatches could hit this. Mitigation: log + drop overflow; coalesce in a later iteration if needed.
2. **PII / secrets in error_summary** — error_summary often carries stack traces with paths. Consider scrubbing before posting. v1: post as-is, document privacy stance, add scrubbing in v2.
3. **Webhook URL is a secret** — never log it; never commit to a checked-in file. Lives in env only.
4. **Phase 1c v2 dependency** — the human-pause permission flow needs Discord notifications WITH a way for the operator to reply. v1 is one-way only; v2 will add a full Discord bot for two-way (operator types `!approve h-abc` in the channel; bot calls handoff.approve). Out of scope for this plan.

## Estimated effort

- Task 1 (operator setup): 15 min
- Task 2 (helper + tests): 1 hour
- Task 3 (worker integration + tests): 1 hour
- Task 4 (smoke): 15 min

Total: ~2.5 hours. Pairs naturally with the Phase 1c v2 plan when it lands.
