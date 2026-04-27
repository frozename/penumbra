#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config/load.js';
import { PenumbraClient } from '../src/penumbra-client.js';
import { runChatTurn } from '../src/cli/loop.js';
import { parseApprovalKey } from '../src/cli/inline-approval.js';
import { parseInputStream } from '../src/cli/input.js';
import { resolveInitialAgent } from '../src/cli/route-input.js';
import { runAutoChain } from '../src/cli/auto-loop.js';
import { parseAttachFlags, buildAttachmentPreamble } from '../src/cli/attachments.js';

import { resolveDaemonStorageRoot } from '@penumbra/core';

const cmd = process.argv[2];
const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');

if (cmd === 'help' || cmd === '--help' || cmd === undefined) {
  console.log('usage: agentchat <new|resume|queue|approve|reject> [args]');
  process.exit(0);
}

let storageRoot: string;
try {
  storageRoot = resolveDaemonStorageRoot();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (cmd === 'new') {
  const project = process.argv.find(a => !a.startsWith('-') && a !== 'new' && a !== process.argv[1] && a !== process.argv[0]) ?? null;
  const isAuto = process.argv.includes('--auto');
  const isTrust = process.argv.includes('--trust');
  const thin = process.argv.includes('--thin');
  const useChain = isAuto || isTrust;
  const trustMode: 'all' | 'config' = isAuto ? 'all' : 'config';

  const maxHopsIdx = process.argv.indexOf('--max-hops');
  const maxHops = maxHopsIdx >= 0 ? parseInt(process.argv[maxHopsIdx + 1]!, 10) : 5;
  if (useChain && maxHops <= 0) {
    console.error('--max-hops must be greater than 0');
    process.exit(1);
  }

  const budgetIdx = process.argv.indexOf('--transcript-budget');
  const transcriptBudget = budgetIdx >= 0 ? parseInt(process.argv[budgetIdx + 1]!, 10) : 8192;

  const initialAgentIdx = process.argv.indexOf('--initial-agent');
  const initialAgentOverride = initialAgentIdx >= 0 ? process.argv[initialAgentIdx + 1] : undefined;

  const config = loadConfig(configPath);
  const conv = { id: `conv-${Date.now()}`, project_id: project };
  const penumbra = new PenumbraClient({ storageRoot });

  const projectContext = (() => {
    if (!project) return undefined;
    const path = join(storageRoot, 'context', project, 'latest.md');
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  })();

  let attachmentPreamble = '';
  try {
    attachmentPreamble = buildAttachmentPreamble(parseAttachFlags(process.argv));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const stdinMode: 'split' | 'whole' = process.stdin.isTTY ? 'split' : 'whole';
  if (stdinMode === 'split') process.stdout.write(`> `);
  const rl = createInterface({ input: process.stdin });
  const events = parseInputStream(rl[Symbol.asyncIterator](), { mode: stdinMode });

  let firstMessage = true;
  for await (const event of events) {
    if (event.kind === 'done') break;
    // Attachments only fire on the first user message — subsequent turns reuse
    // the conversation transcript. The preamble matches the llama-server webui's
    // `--- File: <name> ---` header convention so any model trained on that
    // format reads the file contents naturally.
    const userMessage = firstMessage && attachmentPreamble
      ? attachmentPreamble + event.text
      : event.text;
    firstMessage = false;

    let initialAgent: string;
    try {
      initialAgent = resolveInitialAgent(
        userMessage,
        config,
        initialAgentOverride ? { explicit: initialAgentOverride } : {},
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (!initialAgent) { console.error('no default planner configured and no valid mention found'); process.exit(1); }

    if (useChain && thin) {
      await penumbra.startChain({
        initial_agent: initialAgent,
        message: userMessage,
        conversation_id: conv.id,
        project_id: conv.project_id,
        max_hops: maxHops,
        trust_mode: trustMode,
      });

      let lastHandoffId: string | null = null;
      try {
        for await (const event of penumbra.subscribeConversation(conv.id)) {
          if (event.type === 'hop-start') {
            process.stdout.write(`\\n[${event.agent_name}]\\n`);
          } else if (event.type === 'token') {
            process.stdout.write(event.delta);
          } else if (event.type === 'hop-end') {
            process.stdout.write('\\n\\n');
            if (event.error) {
              console.error(`[error: ${event.error}]`);
            } else if (event.next_handoff_id) {
              lastHandoffId = event.next_handoff_id;
              console.log(`[auto-approved → next step]`);
            }
          } else if (event.type === 'chain-end') {
            if (event.reason === 'max_hops' && lastHandoffId) {
              console.log(`[max-hops ${maxHops} reached, handoff ${lastHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${lastHandoffId.slice(0, 8)}']`);
            } else if (event.reason === 'cancelled' && lastHandoffId) {
              console.log(`[chain stopped at untrusted edge, handoff ${lastHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${lastHandoffId.slice(0, 8)}']`);
            } else if (event.reason === 'error') {
              console.error(`[chain ended with error]`);
            }
            break;
          }
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
      }
    } else if (useChain) {
      const res = await runAutoChain({
        config,
        initialAgent,
        userMessage,
        conversation: conv,
        maxHops,
        transcriptBudget,
        observe: (e) => penumbra.observe(e),
        createHandoff: (body) => penumbra.createHandoff(body),
        approve: (id, body) => penumbra.approve(id, body),
        markFailed: (id, reason) => penumbra.markFailed(id, reason),
        trustMode,
        projectContext,
        onChunk: (s) => process.stdout.write(s),
      });

      if (res.terminatedReason === 'max_hops' && res.cappedHandoffId) {
        console.log(`[max-hops ${maxHops} reached, handoff ${res.cappedHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${res.cappedHandoffId.slice(0, 8)}']`);
      } else if (res.terminatedReason === 'untrusted' && res.cappedHandoffId) {
        console.log(`[chain stopped at untrusted edge, handoff ${res.cappedHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${res.cappedHandoffId.slice(0, 8)}']`);
      }
    } else {
      process.stdout.write(`\n[${initialAgent}]\n`);
      const turn = await runChatTurn({
        config, initialAgent, userMessage, conversation: conv,
        observe: (e) => penumbra.observe(e),
        onChunk: (s) => process.stdout.write(s),
      });
      process.stdout.write('\n\n');
      if (turn.error) {
        console.error(`[${initialAgent}] error: ${turn.error.message}\n`);
        process.stdout.write(`> `);
        continue;
      }

      if (turn.next_mention) {
        const handoff = await penumbra.createHandoff({
          from: initialAgent,
          to: turn.next_mention.resolution.kind === 'unknown' ? turn.next_mention.target : (turn.next_mention.resolution as any).agent_name,
          to_role: turn.next_mention.resolution.kind === 'role' ? (turn.next_mention.resolution as any).role : null,
          message: turn.text,
          conversation_id: conv.id,
          project_id: conv.project_id,
          triggered_by_event_id: turn.response_event_id,
        });
        let reply = '';
        try {
          reply = await rl.question(`[handoff ${handoff.handoff_id.slice(0, 8)}…] @${turn.next_mention.target}\napprove? [y/n/r <name>/s] › `);
        } catch (err: any) {
          if (err.code === 'ERR_USE_AFTER_CLOSE') {
            console.log('\n[stdin closed, ending]');
            break;
          }
          throw err;
        }
        const choice = parseApprovalKey(reply);
        if (choice?.kind === 'yes') {
          await penumbra.approve(handoff.handoff_id);
          console.log(`approved.`);
        } else if (choice?.kind === 'redirect') {
          await penumbra.approve(handoff.handoff_id, { redirect_to: choice.target });
          console.log(`redirected → ${choice.target}.`);
        } else if (choice?.kind === 'no') {
          await penumbra.approve(handoff.handoff_id, { reject: true });
          console.log(`rejected.`);
        }
      }
    }
    process.stdout.write(`> `);
  }
  rl.close();
  process.exit(0);
}

if (cmd === 'queue') {
  if (process.argv[3] === '--help') {
    console.log('usage: agentchat queue');
    process.exit(0);
  }
  const { runQueue } = await import('../src/cli/queue.js');
  const rows = await runQueue({ storageRoot });
  console.log(`HANDOFF_ID\tTS\t\t\tFROM\t\tTO\t\tSTATUS\t\tMESSAGE`);
  for (const r of rows) {
    console.log(`${r.handoff_id.slice(0, 8)}\t${r.ts}\t${r.from_agent.padEnd(8)}\t${r.to_agent.padEnd(8)}\t${r.status.padEnd(8)}\t${r.message.slice(0, 60)}`);
  }
  process.exit(0);
}

if (cmd === 'approve' || cmd === 'reject') {
  const id = process.argv[3];
  if (!id) { console.error(`usage: agentchat ${cmd} <handoff_id> [--redirect <name>] [--reason <text>]`); process.exit(1); }
  const redirectIdx = process.argv.indexOf('--redirect');
  const redirectTo = redirectIdx >= 0 ? (process.argv[redirectIdx + 1] ?? undefined) : undefined;
  const reasonIdx = process.argv.indexOf('--reason');
  const reason = reasonIdx >= 0 ? (process.argv[reasonIdx + 1] ?? undefined) : undefined;
  const { runApprove } = await import('../src/cli/approve.js');
  const r = await runApprove({
    storageRoot, handoffId: id,
    redirectTo, reason,
    reject: cmd === 'reject',
  });
  console.log(`${r.handoff_id} ${r.status}.`);
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(1);
