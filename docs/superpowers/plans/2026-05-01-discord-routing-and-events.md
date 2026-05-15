# Discord Routing And Event Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Penumbra Discord notifications with project routing, agent identity overrides, broader high-signal event coverage, validation/dry-run commands, and reliability controls while preserving the existing single-webhook behavior.

**Architecture:** Keep Discord delivery in the agentchat worker surface, but model configuration as a channel-agnostic `notifications` block in `agentchat.yaml` so Slack can be added later. Add focused helpers for config normalization, route resolution, event rendering, scheduling, and rate limiting, then wire those helpers into dispatcher, reconciler, permission, and watchdog-adjacent event paths. Existing env-only installs keep working when no `notifications` block is present.

**Tech Stack:** Bun, TypeScript, zod, `js-yaml`, existing `PenumbraClient`, Discord webhook API.

---

## Current Facts From Exploration

- `packages/agentchat/src/worker/discord-notifier.ts` owns payload types, embed formatting, and `postToDiscord()`.
- `postToDiscord()` no-ops without a webhook, retries once on 5xx, returns `false` on failure, and never throws.
- `packages/agentchat/bin/agentchat-worker.ts` reads `PENUMBRA_DISCORD_WEBHOOK_URL`, `PENUMBRA_DISCORD_QUIET`, and `PENUMBRA_DISCORD_INCLUDE_PROMPT` after daemon storage-root bootstrap.
- `createWorkerDispatcher()` emits `onChainEnd(handoff, reason)` and already posts `hop-start`, `hop-end`, and `chain-end` progress events.
- `createMergeReconciler()` has a `notifyResult?: (handoffId, result) => Promise<void> | void` hook.
- Permission request/decision/expiry events already flow through daemon routes and `PermissionDaemonClient`, but permission rows do not store `project_id`.
- `HandoffRow` carries `project_id`, `handoff_id`, `conversation_id`, `to_agent`, `message`, `status`, `error_message`, `worker_id`, and `parent_handoff_id`.
- Agent config carries `name`, `adapter`, `roles`, `description`, `tags`, `quirks`, and loose `options`, including model/provider-like fields for several adapters.
- Setup docs already warn that launchd-managed workers need env vars in `~/Library/LaunchAgents/dev.penumbra.worker.plist`.

## File Structure

| Action | Path | Responsibility |
| --- | --- | --- |
| Modify | `packages/agentchat/src/config/types.ts` | Add optional channel-agnostic `notifications` schema. |
| Create | `packages/agentchat/src/worker/notification-config.ts` | Merge env + config into runtime notification settings. |
| Create | `packages/agentchat/src/worker/notification-router.ts` | Resolve project route, channel webhook, fallback webhook, and agent identity. |
| Create | `packages/agentchat/src/worker/discord-events.ts` | Define notification event union and render Discord embeds. |
| Modify | `packages/agentchat/src/worker/discord-notifier.ts` | Support webhook username/avatar payload overrides and preserve current exports. |
| Modify | `packages/agentchat/bin/agentchat-worker.ts` | Wire config, router, dispatcher/reconciler/permission events, and delivery logging. |
| Create | `packages/agentchat/src/worker/notification-scheduler.ts` | Schedule worker-owned cost/quota summary notifications. |
| Modify | `packages/agentchat/src/worker/dispatcher.ts` | Add hooks for dispatch start and retry/exhausted signals. |
| Modify | `packages/daemon/src/services/watchdog.ts` | Emit observable watchdog failure metadata without direct Discord coupling. |
| Modify | `packages/daemon/src/routes/permissions.ts` and `packages/daemon/src/sweepers/permission-ttl.ts` | Ensure permission event payloads include fields needed for notification rendering. |
| Modify | `packages/agentchat/bin/agentchat.ts` | Add `agentchat discord validate|render|test`. |
| Create | `packages/agentchat/src/cli/discord.ts` | CLI implementation for validation, dry-run render, and test post. |
| Modify | `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md` | Document project routing, identity overrides, and launchd env propagation. |
| Test | `packages/agentchat/test/worker/notification-config.test.ts` | Config normalization tests. |
| Test | `packages/agentchat/test/worker/notification-router.test.ts` | Routing and identity tests. |
| Test | `packages/agentchat/test/worker/discord-events.test.ts` | Event rendering/privacy tests. |
| Test | `packages/agentchat/test/worker/discord-notifier.test.ts` | Transport and payload override tests. |
| Test | `packages/agentchat/test/worker/dispatcher.test.ts` | Dispatch hook tests. |
| Test | `packages/agentchat/test/worker/notification-scheduler.test.ts` | Scheduled cost/quota summary tests. |
| Test | `packages/agentchat/test/cli/discord.test.ts` | CLI validation/render/test command tests. |
| Test | `packages/daemon/test/routes/permissions.test.ts` and `packages/daemon/test/services/watchdog.test.ts` | Event metadata coverage tests. |

## Resolved Decisions

1. Store notification config in `agentchat.yaml`, but use a channel-agnostic `notifications` schema rather than a Discord-only top-level block.
2. Match project routes by exact `project_id` string.
3. Make permission requested, decided, and expired notifications default-on.
4. Schedule worker-owned cost/quota summaries by default, while still supporting CLI render/test.

## Status Snapshot — 2026-05-02

Audit performed against `main` after the plan was drafted. Several tasks landed as standalone modules but were never integrated into the worker, so the new infrastructure is presently dead code. Read this snapshot before executing.

| # | Task | State | Notes / commits on `main` |
|---|---|---|---|
| 1 | Notification config schema + normalizer | ✅ shipped | `7e6b9c9 feat(agentchat): add notification config` |
| 2 | Project routing + agent identity | ✅ shipped | `c82bb6f feat(agentchat): route notifications by project`, `4fbbd35 fix(agentchat): resolve routed notification webhooks` |
| 3 | Discord event renderer | ✅ shipped | `a8bdfec feat(agentchat): render discord notification events`, plus `5819884` ascii truncation |
| 4 | Wire dispatcher + merge events through router | ❌ **NOT WIRED** | `agentchat-worker.ts` still reads `PENUMBRA_DISCORD_WEBHOOK_URL` directly (lines 70–72) and calls `postToDiscord()` from `maybePostDiscordChainEnd()` / `maybePostDiscordMergeResult()` (lines 95–155). `loadNotificationConfig`, `resolveNotificationRoute`, and `renderDiscordEvent` are never invoked. Without this task, T1/T2/T3/T6/T7 are all dead code. |
| 5 | Permission notification coverage | ❌ no producer | Renderer types in `discord-events.ts` exist for `permission_requested` / `_decided` / `_expired`, but no daemon or worker code emits them. `permission_row` schema still lacks `project_id`. |
| 6 | Watchdog failure metadata | ⚠️ daemon-only | `8c80a4f feat(daemon): expose watchdog notification events` ships emission on the daemon side, but the worker doesn't subscribe and feed it through the router. |
| 7 | Rate limiting + coalescing | ⚠️ module-only | `c9e4b6e feat(agentchat): coalesce noisy discord events` exists; not wired into the delivery path. |
| 8 | Scheduled cost/quota summaries | ❌ absent | `notification-scheduler.ts` and its test do not exist. Schema field `cost_quota_summary` and renderer case exist but no scheduler. |
| 9 | Operator CLI | ❌ absent | `packages/agentchat/src/cli/discord.ts` and its test do not exist. `packages/agentchat/bin/agentchat.ts` has no `discord` subcommand. |
| 10 | Docs + migration notes | ❌ stale | `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md` predates this plan; routing/identity/launchd guidance not added. |
| 11 | Final verification sweep | n/a until 4–10 land | — |

**Suggested execution order from here:** T4 first (the keystone), then T5, then T8, then T9, then T10, then T11. T6 and T7 wiring fold into T4 as small follow-ons. Snippets in the original task sections below remain valid; cross-check current file contents before pasting (some snippets reference earlier shapes).

**Stale agent branches to ignore (do not merge):** `agent/f6fff7da-…`, `agent/08a8881f-…`, `agent/1dd0feec-…` — all carry redundant `feat(agentchat): add notification config` commits that pre-date or regress `7e6b9c9` already on main.

---

## Task 1: Add Notification Config Schema And Runtime Normalizer

**Files:**
- Modify: `packages/agentchat/src/config/types.ts`
- Create: `packages/agentchat/src/worker/notification-config.ts`
- Test: `packages/agentchat/test/worker/notification-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/worker/notification-config.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { AgentChatConfigSchema } from '../../src/config/types.js';
import { loadNotificationConfig } from '../../src/worker/notification-config.js';

describe('notifications config schema', () => {
  it('accepts a channel-agnostic project route and identity mapping', () => {
    const parsed = AgentChatConfigSchema.parse({
      agents: [{ name: 'codex', adapter: 'codex-cli' }],
      notifications: {
        enabled: true,
        prompt_policy: 'never',
        channels: {
          discord: { kind: 'discord_webhook', default_webhook_url_env: 'PENUMBRA_DISCORD_WEBHOOK_URL' },
        },
        routes: {
          projects: {
            penumbra: { channel: 'discord', webhook_url_env: 'PENUMBRA_DISCORD_PROJECT_PENUMBRA_WEBHOOK_URL' },
          },
        },
        identities: {
          agents: {
            codex: { display_name: 'Penumbra / Codex', avatar_url_env: 'PENUMBRA_DISCORD_AVATAR_CODEX_URL' },
          },
        },
      },
    });
    expect(parsed.notifications?.routes?.projects?.penumbra?.channel).toBe('discord');
  });
});

describe('loadNotificationConfig', () => {
  it('preserves env-only default webhook behavior when notifications block is absent', () => {
    const cfg = loadNotificationConfig({
      agentchat: { agents: [{ name: 'codex', adapter: 'codex-cli', options: {}, roles: [], auto_approve_to: [] }], default_roles: {}, providers: [] },
      env: { PENUMBRA_DISCORD_WEBHOOK_URL: 'https://discord.test/api/webhooks/default/token' },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.channels.discord?.defaultWebhookUrl).toBe('https://discord.test/api/webhooks/default/token');
    expect(cfg.events.dispatch_end).toBe(true);
    expect(cfg.events.permission_decided).toBe(true);
    expect(cfg.events.cost_quota_summary).toBe(true);
    expect(cfg.promptPolicy).toBe('never');
  });

  it('quiet env disables configured routes', () => {
    const cfg = loadNotificationConfig({
      agentchat: {
        agents: [{ name: 'codex', adapter: 'codex-cli', options: {}, roles: [], auto_approve_to: [] }],
        default_roles: {},
        providers: [],
        notifications: {
          enabled: true,
          channels: {
            discord: { kind: 'discord_webhook', default_webhook_url_env: 'PENUMBRA_DISCORD_WEBHOOK_URL' },
          },
        },
      },
      env: {
        PENUMBRA_DISCORD_WEBHOOK_URL: 'https://discord.test/api/webhooks/default/token',
        PENUMBRA_DISCORD_QUIET: '1',
      },
    });
    expect(cfg.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/notification-config.test.ts
```

Expected: FAIL because the `notifications` schema and `notification-config.ts` do not exist.

- [ ] **Step 3: Implement minimal schema and normalizer**

Add zod schemas in `packages/agentchat/src/config/types.ts`:

```ts
export const NotificationEventConfigSchema = z.object({
  dispatch_start: z.boolean().optional(),
  dispatch_end: z.boolean().optional(),
  dispatch_failure: z.boolean().optional(),
  watchdog_failure: z.boolean().optional(),
  claim_retry: z.boolean().optional(),
  adapter_retry_exhausted: z.boolean().optional(),
  permission_requested: z.boolean().optional(),
  permission_decided: z.boolean().optional(),
  permission_expired: z.boolean().optional(),
  merge_result: z.boolean().optional(),
  cost_quota_summary: z.boolean().optional(),
}).default({});

export const NotificationChannelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('discord_webhook'),
    default_webhook_url_env: z.string().min(1).default('PENUMBRA_DISCORD_WEBHOOK_URL'),
  }),
]);

export const NotificationProjectRouteSchema = z.object({
  channel: z.string().min(1).default('discord'),
  webhook_url_env: z.string().min(1).optional(),
  include_prompt: z.boolean().optional(),
  prompt_policy: z.enum(['never', 'summary', 'always']).optional(),
});

export const NotificationIdentitySchema = z.object({
  display_name: z.string().min(1).optional(),
  avatar_url: z.string().url().optional(),
  avatar_url_env: z.string().min(1).optional(),
});

export const NotificationSummaryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  interval: z.enum(['hourly', 'daily']).default('daily'),
  channel: z.string().min(1).default('discord'),
}).default({});

export const NotificationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  include_prompt: z.boolean().optional(),
  prompt_policy: z.enum(['never', 'summary', 'always']).default('never'),
  events: NotificationEventConfigSchema,
  channels: z.record(z.string(), NotificationChannelSchema).default({}),
  routes: z.object({
    projects: z.record(z.string(), NotificationProjectRouteSchema).default({}),
  }).default({ projects: {} }),
  identities: z.object({
    agents: z.record(z.string(), NotificationIdentitySchema).default({}),
  }).default({ agents: {} }),
  summaries: z.object({
    cost_quota: NotificationSummaryConfigSchema,
  }).default({ cost_quota: { enabled: true, interval: 'daily', channel: 'discord' } }),
}).optional();
```

Create `packages/agentchat/src/worker/notification-config.ts` with:

- `DEFAULT_NOTIFICATION_EVENTS` defaulting high-signal events on, including `permission_decided` and `cost_quota_summary`.
- `loadNotificationConfig({ agentchat, env })`.
- Env back-compat for `PENUMBRA_DISCORD_WEBHOOK_URL`, `PENUMBRA_DISCORD_QUIET`, and `PENUMBRA_DISCORD_INCLUDE_PROMPT`.
- A default `discord` channel when only env is configured.
- No logging or printing of webhook values.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/notification-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/config/types.ts packages/agentchat/src/worker/notification-config.ts packages/agentchat/test/worker/notification-config.test.ts
git commit -m "feat(agentchat): add notification config"
```

## Task 2: Add Project Routing And Agent Identity Resolution

**Files:**
- Create: `packages/agentchat/src/worker/notification-router.ts`
- Test: `packages/agentchat/test/worker/notification-router.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/worker/notification-router.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { resolveNotificationRoute } from '../../src/worker/notification-router.js';

describe('resolveNotificationRoute', () => {
  it('uses a project webhook over the default webhook', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        events: {} as any,
        channels: {
          discord: { kind: 'discord_webhook', defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token' },
        },
        routes: {
          projects: {
            penumbra: { channel: 'discord', webhookUrl: 'https://discord.test/api/webhooks/project/token', promptPolicy: 'never' },
          },
        },
        identities: { agents: {} },
      },
      projectId: 'penumbra',
      agentName: 'codex',
    });
    expect(route?.webhookUrl).toBe('https://discord.test/api/webhooks/project/token');
    expect(route?.channelKind).toBe('discord_webhook');
  });

  it('falls back to the default webhook for unknown projects', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        events: {} as any,
        channels: {
          discord: { kind: 'discord_webhook', defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token' },
        },
        routes: { projects: {} },
        identities: { agents: {} },
      },
      projectId: 'other',
      agentName: 'codex',
    });
    expect(route?.webhookUrl).toBe('https://discord.test/api/webhooks/default/token');
  });

  it('applies webhook username and avatar overrides for the agent', () => {
    const route = resolveNotificationRoute({
      config: {
        enabled: true,
        promptPolicy: 'never',
        events: {} as any,
        channels: {
          discord: { kind: 'discord_webhook', defaultWebhookUrl: 'https://discord.test/api/webhooks/default/token' },
        },
        routes: { projects: {} },
        identities: {
          agents: {
            codex: { displayName: 'Penumbra / Codex', avatarUrl: 'https://example.com/codex.png' },
          },
        },
      },
      projectId: null,
      agentName: 'codex',
    });
    expect(route?.identity).toEqual({ username: 'Penumbra / Codex', avatar_url: 'https://example.com/codex.png' });
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/notification-router.test.ts
```

Expected: FAIL because `notification-router.ts` does not exist.

- [ ] **Step 3: Implement route resolver**

Create `packages/agentchat/src/worker/notification-router.ts` exporting:

```ts
export interface NotificationRouteResolution {
  channelName: string;
  channelKind: 'discord_webhook';
  webhookUrl: string;
  routeKey: string;
  promptPolicy: 'never' | 'summary' | 'always';
  identity?: { username?: string; avatar_url?: string };
}
```

Implement `resolveNotificationRoute({ config, projectId, agentName })`:

- Return `null` when disabled.
- Use exact project match first.
- Fall back to the configured default Discord channel webhook.
- Apply agent identity by exact agent name and map `displayName` to Discord `username`.
- Do not expose webhook tokens in route keys; use `project:<project_id>` or `default`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/notification-router.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/notification-router.ts packages/agentchat/test/worker/notification-router.test.ts
git commit -m "feat(agentchat): route notifications by project"
```

## Task 3: Generalize Discord Event Rendering

**Files:**
- Create: `packages/agentchat/src/worker/discord-events.ts`
- Modify: `packages/agentchat/src/worker/discord-notifier.ts`
- Test: `packages/agentchat/test/worker/discord-events.test.ts`
- Test: `packages/agentchat/test/worker/discord-notifier.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/agentchat/test/worker/discord-events.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { renderDiscordEvent } from '../../src/worker/discord-events.js';

describe('renderDiscordEvent', () => {
  it('renders dispatch end without prompt by default', () => {
    const payload = renderDiscordEvent({
      kind: 'dispatch_end',
      project_id: 'penumbra',
      handoff_id: 'h-1',
      conversation_id: 'c-1',
      agent: 'codex',
      status: 'completed',
      latency_seconds: 12,
      prompt: 'private prompt',
    }, { promptPolicy: 'never' });
    const json = JSON.stringify(payload);
    expect(json).toContain('dispatch completed');
    expect(json).toContain('penumbra');
    expect(json).not.toContain('private prompt');
  });

  it('renders permission request without raw tool input', () => {
    const payload = renderDiscordEvent({
      kind: 'permission_requested',
      project_id: 'penumbra',
      permission_id: 'p-1',
      handoff_id: 'h-1',
      conversation_id: 'c-1',
      agent: 'claude',
      tool_name: 'terminal.create',
      ttl_at: '2026-05-01T12:00:00.000Z',
    }, { promptPolicy: 'always' });
    const json = JSON.stringify(payload);
    expect(json).toContain('permission requested');
    expect(json).toContain('terminal.create');
    expect(json).not.toContain('raw_input');
  });

  it('renders watchdog failures as red high-signal events', () => {
    const payload = renderDiscordEvent({
      kind: 'watchdog_failure',
      project_id: 'penumbra',
      handoff_id: 'h-1',
      conversation_id: 'c-1',
      agent: 'gemini',
      worker_id: 'worker-primary',
      error_summary: 'worker timeout',
    }, { promptPolicy: 'never' });
    expect(payload.embeds[0]?.color).toBe(0xcc0000);
    expect(JSON.stringify(payload)).toContain('worker-primary');
  });
});
```

Add to `packages/agentchat/test/worker/discord-notifier.test.ts`:

```ts
it('includes webhook identity overrides in the payload', async () => {
  const fetchMock = mock(async () => new Response('', { status: 204 }));
  await postToDiscord(
    'https://discord.test/api/webhooks/abc',
    { embeds: [{ title: 'x', color: 0, fields: [] }] },
    fetchMock,
    undefined,
    { username: 'Penumbra / Codex', avatar_url: 'https://example.com/codex.png' },
  );
  const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
  expect(body.username).toBe('Penumbra / Codex');
  expect(body.avatar_url).toBe('https://example.com/codex.png');
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/discord-events.test.ts packages/agentchat/test/worker/discord-notifier.test.ts
```

Expected: FAIL because event rendering and the new `postToDiscord` identity argument do not exist.

- [ ] **Step 3: Implement event rendering and identity payloads**

Implement `DiscordNotificationEvent` union in `discord-events.ts` for:

- `dispatch_start`
- `dispatch_end`
- `dispatch_failure`
- `watchdog_failure`
- `claim_retry`
- `adapter_retry_exhausted`
- `permission_requested`
- `permission_decided`
- `permission_expired`
- `merge_result`
- `cost_quota_summary`

Render embeds with fields:

- `project` when available.
- `agent`.
- `status` or event-specific state.
- `handoff`.
- `conversation`.
- `worker` when available.
- `provider` and `model` when available.
- `pr` when available.

Keep prompts excluded unless `promptPolicy` is `summary` or `always`. Never include raw permission input.

Extend `postToDiscord()` signature to accept an optional identity argument after `sleep`, while preserving existing callers:

```ts
export async function postToDiscord(
  webhookUrl: string | undefined,
  contentOrEmbed: string | DiscordEmbedsPayload,
  fetchFn: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  identity?: { username?: string; avatar_url?: string },
): Promise<boolean>
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/discord-events.test.ts packages/agentchat/test/worker/discord-notifier.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/discord-events.ts packages/agentchat/src/worker/discord-notifier.ts packages/agentchat/test/worker/discord-events.test.ts packages/agentchat/test/worker/discord-notifier.test.ts
git commit -m "feat(agentchat): render discord notification events"
```

## Task 4: Wire Worker Dispatch And Merge Events Through The Router

**Files:**
- Modify: `packages/agentchat/src/worker/dispatcher.ts`
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Test: `packages/agentchat/test/worker/dispatcher.test.ts`
- Test: existing worker Discord tests as needed.

- [ ] **Step 1: Write the failing dispatcher hook tests**

Extend `packages/agentchat/test/worker/dispatcher.test.ts` with tests that assert:

```ts
expect(events).toContainEqual(expect.objectContaining({
  kind: 'dispatch_start',
  handoff_id: 'h-1',
  conversation_id: 'c-1',
  agent: 'codex',
}));
```

and:

```ts
expect(events).toContainEqual(expect.objectContaining({
  kind: 'claim_retry',
  handoff_id: 'h-1',
  agent: 'codex',
}));
```

Use injected hooks rather than a real Discord post:

```ts
onDispatchEvent: (event) => events.push(event),
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/dispatcher.test.ts
```

Expected: FAIL because `onDispatchEvent` is not defined.

- [ ] **Step 3: Implement dispatcher event hook**

Add optional `onDispatchEvent?: (event: DispatchNotificationEvent) => void` to `WorkerDispatcherDeps`.

Emit:

- `dispatch_start` after a successful claim and before first `hop-start`.
- `claim_retry` in the retryable claim failure branch.
- `adapter_retry_exhausted` when `dispatch()` returns `terminatedReason: 'error'` or throws before completion.
- Keep `onChainEnd` for terminal chain behavior so current behavior is preserved.

- [ ] **Step 4: Wire worker delivery**

In `packages/agentchat/bin/agentchat-worker.ts`:

- Replace direct env reads with `loadNotificationConfig({ agentchat: config, env: process.env })`.
- Add `postDiscordEvent(event)` helper that resolves route, renders payload, posts with identity, and logs failed delivery without webhook URL.
- Convert existing `maybePostDiscordChainEnd()` and `maybePostDiscordMergeResult()` to produce `DiscordNotificationEvent`.
- Include `project_id`, `worker_id`, `provider`, and `model` when known.
- Preserve `PENUMBRA_DISCORD_QUIET` and `PENUMBRA_DISCORD_INCLUDE_PROMPT` behavior.

- [ ] **Step 5: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/dispatcher.test.ts packages/agentchat/test/worker/discord-events.test.ts packages/agentchat/test/worker/notification-router.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agentchat/src/worker/dispatcher.ts packages/agentchat/bin/agentchat-worker.ts packages/agentchat/test/worker/dispatcher.test.ts
git commit -m "feat(agentchat): route dispatch discord events"
```

## Task 5: Add Permission Notification Coverage

**Files:**
- Modify: `packages/agentchat/src/worker/permission-daemon-client.ts`
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Modify: `packages/daemon/src/routes/permissions.ts`
- Modify: `packages/daemon/src/sweepers/permission-ttl.ts`
- Test: `packages/agentchat/test/worker/permission-daemon-client.test.ts`
- Test: `packages/daemon/test/routes/permissions.test.ts`

- [ ] **Step 1: Write failing tests**

Add daemon route assertions that `permission.created`, `permission.decided`, and `permission.expired` payloads include:

```ts
{
  permission_id: 'p-1',
  parent_handoff_id: 'h-1',
  conversation_id: 'c-1',
  agent_name: 'codex',
  tool_name: 'terminal.create'
}
```

Add `PermissionDaemonClient` tests that expose a callback:

```ts
const seen: any[] = [];
const client = new PermissionDaemonClient({ ..., onPermissionEvent: (event) => seen.push(event) });
```

Expected events:

- `permission_requested` when `requestPermission()` creates a permission.
- `permission_decided` when SSE emits `permission.decided`.
- `permission_expired` when SSE emits `permission.expired`.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/daemon/test/routes/permissions.test.ts packages/agentchat/test/worker/permission-daemon-client.test.ts
```

Expected: FAIL because the client callback and full expiry payload are not wired.

- [ ] **Step 3: Implement permission event callback**

In `PermissionDaemonClient`:

- Add optional `onPermissionEvent`.
- Emit `permission_requested` after a successful fresh create response, using input fields and returned `permission_id`/`ttl_at`.
- Emit `permission_decided` and `permission_expired` from SSE payloads.

In worker:

- On permission event, look up `parent_handoff_id` with `client.getHandoff()` to get `project_id`, prompt policy, and route.
- Render and post event only if the corresponding event flag is enabled.
- Do not include `raw_input` in Discord payload.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/daemon/test/routes/permissions.test.ts packages/agentchat/test/worker/permission-daemon-client.test.ts packages/agentchat/test/worker/discord-events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/permission-daemon-client.ts packages/agentchat/bin/agentchat-worker.ts packages/daemon/src/routes/permissions.ts packages/daemon/src/sweepers/permission-ttl.ts packages/agentchat/test/worker/permission-daemon-client.test.ts packages/daemon/test/routes/permissions.test.ts
git commit -m "feat(agentchat): notify discord for permission events"
```

## Task 6: Add Watchdog Failure Notification Metadata

**Files:**
- Modify: `packages/daemon/src/services/watchdog.ts`
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Test: `packages/daemon/test/services/watchdog.test.ts`
- Test: `packages/agentchat/test/worker/discord-events.test.ts`

- [ ] **Step 1: Write failing tests**

In `packages/daemon/test/services/watchdog.test.ts`, assert that when the watchdog fails a dispatched handoff it emits or records enough metadata for:

```ts
{
  kind: 'watchdog_failure',
  worker_id: 'worker-primary',
  handoff_id: 'h-1',
  conversation_id: 'c-1',
  project_id: 'penumbra',
  agent: 'codex',
  error_summary: 'worker timeout'
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/daemon/test/services/watchdog.test.ts
```

Expected: FAIL because watchdog currently emits only conversation stream `chain-end` and does not include notification-shaped metadata.

- [ ] **Step 3: Implement minimal metadata emission**

Prefer a non-Discord-specific hook on `Services`, for example:

```ts
notificationEvents?: {
  emit(event: Record<string, unknown>): void;
}
```

Emit a generic event when watchdog marks a handoff failed. Keep direct Discord transport out of the daemon. If no notification event bus exists, no-op.

Worker follow-up:

- If an existing SSE route can carry these events without schema churn, subscribe and post them.
- If not, leave daemon metadata emission covered by tests and document worker subscription as a follow-up task before enabling default-on watchdog Discord.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/daemon/test/services/watchdog.test.ts packages/agentchat/test/worker/discord-events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/services/watchdog.ts packages/daemon/test/services/watchdog.test.ts packages/agentchat/bin/agentchat-worker.ts packages/agentchat/test/worker/discord-events.test.ts
git commit -m "feat(daemon): expose watchdog notification events"
```

## Task 7: Add Rate Limiting And Coalescing

**Files:**
- Create: `packages/agentchat/src/worker/discord-rate-limit.ts`
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Test: `packages/agentchat/test/worker/discord-rate-limit.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/agentchat/test/worker/discord-rate-limit.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { createDiscordRateLimiter } from '../../src/worker/discord-rate-limit.js';

describe('createDiscordRateLimiter', () => {
  it('allows the first event and suppresses duplicates within the window', () => {
    let now = 1000;
    const limiter = createDiscordRateLimiter({ now: () => now, windowMs: 30_000 });
    expect(limiter.shouldSend({ webhookKey: 'default', coalesceKey: 'claim_retry:h-1' })).toBe(true);
    now += 1000;
    expect(limiter.shouldSend({ webhookKey: 'default', coalesceKey: 'claim_retry:h-1' })).toBe(false);
    now += 30_000;
    expect(limiter.shouldSend({ webhookKey: 'default', coalesceKey: 'claim_retry:h-1' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/discord-rate-limit.test.ts
```

Expected: FAIL because the limiter does not exist.

- [ ] **Step 3: Implement limiter**

Implement a small in-memory limiter keyed by route key plus event coalesce key. Use it only for noisy events:

- `claim_retry`
- `permission_decided`
- repeated `cost_quota_summary`

Do not rate-limit terminal failures, permission requests, or PR failures.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/discord-rate-limit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/discord-rate-limit.ts packages/agentchat/test/worker/discord-rate-limit.test.ts packages/agentchat/bin/agentchat-worker.ts
git commit -m "feat(agentchat): coalesce noisy discord events"
```

## Task 8: Add Scheduled Cost/Quota Summaries

**Files:**
- Create: `packages/agentchat/src/worker/notification-scheduler.ts`
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Test: `packages/agentchat/test/worker/notification-scheduler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/agentchat/test/worker/notification-scheduler.test.ts`:

```ts
import { describe, expect, it, mock } from 'bun:test';
import { createNotificationScheduler } from '../../src/worker/notification-scheduler.js';

describe('createNotificationScheduler', () => {
  it('fires a daily cost quota summary when enabled', async () => {
    let now = new Date('2026-05-01T09:00:00.000Z').getTime();
    const postEvent = mock(async (_event: any) => {});
    const getQuotaSummary = mock(async () => ({
      providers: [
        { provider: 'openai', model: 'gpt-5.4', used_tokens: 100, quota_tokens: 1000, remaining_pct_tokens: 90 },
      ],
    }));
    const scheduler = createNotificationScheduler({
      now: () => now,
      intervalMs: 60_000,
      config: {
        enabled: true,
        events: { cost_quota_summary: true } as any,
        summaries: { cost_quota: { enabled: true, interval: 'daily', channel: 'discord' } },
      } as any,
      getQuotaSummary,
      postEvent,
    });

    await scheduler.tick();
    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(postEvent.mock.calls[0]?.[0]).toMatchObject({ kind: 'cost_quota_summary' });

    now += 60_000;
    await scheduler.tick();
    expect(postEvent).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/notification-scheduler.test.ts
```

Expected: FAIL because the scheduler does not exist.

- [ ] **Step 3: Implement scheduler**

Create `packages/agentchat/src/worker/notification-scheduler.ts`:

- Export `createNotificationScheduler({ config, now, intervalMs, getQuotaSummary, postEvent })`.
- Support `daily` and `hourly` intervals.
- Fire only when `config.enabled`, `config.events.cost_quota_summary`, and `config.summaries.cost_quota.enabled` are true.
- Build a `cost_quota_summary` notification event containing provider/model rows, used tokens, quota tokens, remaining percentages, and timestamp.
- Expose `start()` and `stop()` methods for worker wiring plus a testable `tick()`.

Wire `agentchat-worker.ts`:

- Start the scheduler only for `worker-primary`, matching the existing usage poller singleton pattern.
- Use `PenumbraClient` or an injected helper to fetch quota status.
- Do not block dispatch on summary failures; log warning metadata without webhook URLs.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/notification-scheduler.test.ts packages/agentchat/test/worker/discord-events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/notification-scheduler.ts packages/agentchat/test/worker/notification-scheduler.test.ts packages/agentchat/bin/agentchat-worker.ts
git commit -m "feat(agentchat): schedule notification summaries"
```

## Task 9: Add Operator CLI UX

**Files:**
- Modify: `packages/agentchat/bin/agentchat.ts`
- Create: `packages/agentchat/src/cli/discord.ts`
- Test: `packages/agentchat/test/cli/discord.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/agentchat/test/cli/discord.test.ts` with tests for:

- `validate` reports default route configured without printing webhook token.
- `render --event dispatch_end --project-id penumbra --agent codex` prints JSON with route key and embed payload.
- `test --project-id penumbra --agent codex` posts once to the resolved webhook using an injected fetch.

Expected assertions:

```ts
expect(output).toContain('default: configured');
expect(output).not.toContain('webhooks/default/token');
expect(JSON.parse(rendered).payload.embeds[0].title).toContain('dispatch');
expect(fetchMock).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/cli/discord.test.ts
```

Expected: FAIL because CLI module and command are missing.

- [ ] **Step 3: Implement CLI module**

Add `runDiscordCli(args, deps)` in `packages/agentchat/src/cli/discord.ts`:

- Load config with `loadConfig`.
- Normalize notification config.
- Validate env variable names and webhook URL shape.
- Mask webhook URLs as `https://discord.com/api/webhooks/<id>/...`.
- Render sample events without requiring daemon.
- Test posts through `postToDiscord`.

Wire `agentchat.ts`:

```ts
if (cmd === 'discord') {
  const { runDiscordCli } = await import('../src/cli/discord.js');
  process.exit(await runDiscordCli(process.argv.slice(3), { env: process.env, fetch }));
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/cli/discord.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/bin/agentchat.ts packages/agentchat/src/cli/discord.ts packages/agentchat/test/cli/discord.test.ts
git commit -m "feat(agentchat): add discord validation commands"
```

## Task 10: Docs And Migration Notes

**Files:**
- Modify: `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md`
- Modify: `docs/superpowers/specs/2026-05-01-discord-routing-and-events-design.md` if implementation changes the design.

- [ ] **Step 1: Update docs**

Add:

- `notifications:` YAML examples for default Discord webhook channel, per-project routes, event flags, identities, and scheduled summaries.
- Launchd plist examples for each webhook env var and avatar URL env var.
- Explicit note: changing launchd env requires worker reload/restart, but implementation does not restart it automatically.
- `agentchat discord validate`, `agentchat discord render`, and `agentchat discord test` usage.
- Privacy defaults: prompt excluded, raw permission input never sent.
- Migration path: existing `PENUMBRA_DISCORD_WEBHOOK_URL` continues working.

- [ ] **Step 2: Verify docs mention launchd env propagation**

Run:

```bash
rg -n "PENUMBRA_DISCORD_WEBHOOK_URL|LaunchAgents|agentchat discord validate|prompt_policy|avatar_url_env" docs/superpowers/notes/2026-04-28-discord-mcp-setup.md
```

Expected: all terms appear.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/notes/2026-04-28-discord-mcp-setup.md docs/superpowers/specs/2026-05-01-discord-routing-and-events-design.md
git commit -m "docs(agentchat): document discord routing setup"
```

## Task 11: Final Verification Sweep

**Files:**
- No new files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test packages/agentchat/test/worker/notification-config.test.ts \
  packages/agentchat/test/worker/notification-router.test.ts \
  packages/agentchat/test/worker/discord-events.test.ts \
  packages/agentchat/test/worker/discord-notifier.test.ts \
  packages/agentchat/test/worker/dispatcher.test.ts \
  packages/agentchat/test/worker/permission-daemon-client.test.ts \
  packages/agentchat/test/worker/discord-rate-limit.test.ts \
  packages/agentchat/test/worker/notification-scheduler.test.ts \
  packages/agentchat/test/cli/discord.test.ts \
  packages/daemon/test/routes/permissions.test.ts \
  packages/daemon/test/services/watchdog.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run broad package tests**

Run:

```bash
bun test packages/agentchat/test/worker packages/agentchat/test/cli packages/daemon/test/routes packages/daemon/test/services
```

Expected: PASS. If Bun hits the known ONNX teardown panic after pass/fail counts, judge by the pass/fail line above the panic.

- [ ] **Step 4: Confirm no secrets in docs or config examples**

Run:

```bash
rg -n "discord.com/api/webhooks/[0-9A-Za-z_-]+/[0-9A-Za-z_-]+" docs packages
```

Expected: no real webhook tokens. Placeholder examples such as `<webhook-id>/<webhook-token>` are acceptable.

- [ ] **Step 5: Commit final adjustments if needed**

```bash
git add .
git commit -m "test(agentchat): verify discord notification routing"
```

Only run this commit if verification required source or test adjustments after Task 10.

## Rollout Risks

- Running workers load config and env at boot. New project routes or launchd env vars will not affect the active worker until the user explicitly reloads/restarts it.
- Permission decisions are default-on by decision, so rate limiting and concise formatting matter.
- Watchdog events originate in the daemon. Avoid direct daemon-to-Discord coupling; use a generic event seam or keep watchdog delivery deferred if the worker cannot subscribe cleanly.
- Webhook identity customization is per message and sufficient for outbound notifications. Multiple Discord bot tokens add OAuth, gateway, and permission complexity and should stay out of this plan.
- Project IDs may be hash-prefixed or declared strings. Exact matching is predictable but users need to copy the actual `project_id`.
- Prompt inclusion is a privacy risk. Keep `never` as the default and never send raw permission tool input.

## Migration Notes

- Existing users with only `PENUMBRA_DISCORD_WEBHOOK_URL` keep current behavior.
- New config can be adopted incrementally: add `notifications.channels.discord.default_webhook_url_env` first, then project routes, identities, and scheduled summaries.
- Launchd-managed workers need every referenced env var in `~/Library/LaunchAgents/dev.penumbra.worker.plist` under `EnvironmentVariables`.
- Do not restart the daemon or worker during implementation unless explicitly requested by the operator.
- No database migration is required for the core routing implementation.
