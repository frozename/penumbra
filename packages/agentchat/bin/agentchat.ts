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

const cmd = process.argv[2];
const configPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
const storageRoot = process.env.PENUMBRA_STORAGE_ROOT ?? join(homedir(), '.penumbra');

if (cmd === 'help' || cmd === '--help' || cmd === undefined) {
  console.log('usage: agentchat <new|resume|queue|approve|reject> [args]');
  process.exit(0);
}

if (cmd === 'new') {
  const project = process.argv.find(a => !a.startsWith('-') && a !== 'new' && a !== process.argv[1] && a !== process.argv[0]) ?? null;
  const isAuto = process.argv.includes('--auto');
  const isTrust = process.argv.includes('--trust');
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

  const config = loadConfig(configPath);
  const conv = { id: `conv-${Date.now()}`, project_id: project };
  const penumbra = new PenumbraClient({ storageRoot });

  const projectContext = (() => {
    if (!project) return undefined;
    const path = join(storageRoot, 'context', project, 'latest.md');
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  })();

  process.stdout.write(`> `);
  const rl = createInterface({ input: process.stdin });
  const events = parseInputStream(rl[Symbol.asyncIterator]());
  
  for await (const event of events) {
    if (event.kind === 'done') break;
    const userMessage = event.text;

    const initialAgent = resolveInitialAgent(userMessage, config);
    if (!initialAgent) { console.error('no default planner configured and no valid mention found'); process.exit(1); }

    if (useChain) {
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
        trustMode,
        projectContext,
      });

      if (res.terminatedReason === 'max_hops' && res.cappedHandoffId) {
        console.log(`[max-hops ${maxHops} reached, handoff ${res.cappedHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${res.cappedHandoffId.slice(0, 8)}']`);
      } else if (res.terminatedReason === 'untrusted' && res.cappedHandoffId) {
        console.log(`[chain stopped at untrusted edge, handoff ${res.cappedHandoffId.slice(0, 8)}… queued — resume with 'agentchat approve ${res.cappedHandoffId.slice(0, 8)}']`);
      }
    } else {
      const turn = await runChatTurn({
        config, initialAgent, userMessage, conversation: conv,
        observe: (e) => penumbra.observe(e),
      });
      if (turn.error) {
        console.error(`\n[${initialAgent}] error: ${turn.error.message}\n`);
        process.stdout.write(`> `);
        continue;
      }
      console.log(`\n[${initialAgent}]\n${turn.text}\n`);

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
