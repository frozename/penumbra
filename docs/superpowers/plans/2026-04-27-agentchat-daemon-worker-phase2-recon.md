# Phase 2 Recon

- TOC: dispatch; daemon-sse; worker; schema; wire. [docs/superpowers/plans/2026-04-27-agentchat-daemon-worker-phase2.md:35]

## 1. Dispatch flow
- Bin calls `runAutoChain`. [packages/agentchat/bin/agentchat.ts:101]
- Loop calls `dispatchHandoff`; finally emits `chain-terminated`. [packages/agentchat/src/cli/auto-loop.ts:67] [packages/agentchat/src/cli/auto-loop.ts:44]
- `dispatchHandoff` builds prompt, retries `runChatTurn`, creates/approves next handoff. [packages/agentchat/src/cli/dispatch-handoff.ts:56] [packages/agentchat/src/cli/dispatch-handoff.ts:113]
- `runChatTurn` observes prompt/response around `buildAdapter` + `ensureDispatchStream`; `observe()` posts `/observations` -> `t0Writer`. [packages/agentchat/src/cli/loop.ts:36] [packages/agentchat/src/adapters/registry.ts:50] [packages/agentchat/src/sdk/stream-wrapper.ts:4] [packages/agentchat/src/penumbra-client.ts:18] [packages/daemon/src/routes/observations.ts:4] [packages/core/src/writers/t0.ts:23]

## 2. Daemon SSE
- Only `/handoffs/events` is SSE. [packages/daemon/src/serve.ts:52]
- No conversation/control SSE routes. [packages/daemon/src/serve.ts:33]
- Frames are `: ok` then `event: handoff`. [packages/daemon/src/routes/handoffs-events.ts:19] [packages/daemon/src/routes/handoffs-events.ts:12]
- Payload is `HandoffRow`; `/chains/history` stays JSON. [packages/core/src/schemas/handoff.ts:15] [packages/daemon/src/routes/chains.ts:62]

## 3. Worker bootstrap
- Worker bin resolves flags, config, client, logger. [packages/agentchat/bin/agentchat-worker.ts:19] [packages/agentchat/bin/agentchat-worker.ts:34]
- Transcript rebuild = `listHandoffs` + sort. [packages/agentchat/bin/agentchat-worker.ts:44]
- Dispatcher = claim + conv lock + semaphore. [packages/agentchat/src/worker/dispatcher.ts:23] [packages/agentchat/src/worker/dispatcher.ts:54]
- Lifecycle = SSE+poll, dispatch, `completeHandoff` finally, idle shutdown. [packages/agentchat/bin/agentchat-worker.ts:120] [packages/agentchat/bin/agentchat-worker.ts:91] [packages/agentchat/bin/agentchat-worker.ts:107] [packages/agentchat/bin/agentchat-worker.ts:134]

## 4. Schema gaps
- `handoffs` lacks `error_message`; fail path writes `resolution_reason`. [packages/core/src/db/schema.ts:92] [packages/core/src/writers/handoff.ts:118]
- No `conversations` table; `conversation_id` is row/session data. [packages/core/src/db/schema.ts:29] [packages/core/src/db/schema.ts:92] [packages/daemon/src/routes/chains.ts:19]
- `failed` already exists; not a gap. [packages/core/src/schemas/handoff.ts:4]
- No zod/service for `hop-start|token|hop-end|chain-end|cancel|progress|hop-cache`. [packages/core/src/schemas/chain.ts:4] [packages/core/src/services.ts:21] [packages/core/src/index.ts:28]

## 5. Wire constants
- No central SSE constants file. [packages/daemon/src/routes/handoffs-events.ts:12]
- `HandoffEventBus` is runtime bus only. [packages/core/src/events/handoff-events.ts:3]
- New wire schemas fit under `core/src/schemas/*`. [packages/core/src/schemas/handoff.ts:1] [packages/core/src/schemas/chain.ts:1]
- Re-export seam is `core/src/index.ts`; client parser is generic. [packages/core/src/index.ts:28] [packages/agentchat/src/penumbra-client.ts:56]

## Top 3 surprises
- `failed` already shipped. [packages/core/src/schemas/handoff.ts:4]
- SSE skips claim/complete/fail transitions. [packages/core/src/writers/handoff.ts:63] [packages/core/src/writers/handoff.ts:132]
- Worker bootstrap lives in-bin, not dispatcher. [packages/agentchat/bin/agentchat-worker.ts:66] [packages/agentchat/src/worker/dispatcher.ts:23]

- Commit SHA: PENDING
